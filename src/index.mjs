#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const WEB_BASE_URL = 'https://www.asosuite.com'
const API_BASE_URL = 'https://server.asosuite.com'
const CONFIG_DIR = path.join(os.homedir(), '.asosuite')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const MAX_KEYWORDS = 50
const MAX_TRACKED_KEYWORDS_ADD = 200
const DEFAULT_POLL_INTERVAL_SECONDS = 3
const DEFAULT_REGION = 'US'
const DEFAULT_PLATFORM = 'iphone'
const DEFAULT_PERIOD = 30
const APP_ID_MIN_LENGTH = 6
const MAX_PLANNED_TRACKED_APP_ID_LENGTH = 64
const TRACKED_KEYWORDS_MAX_PAGE = 1000
const TRACKED_KEYWORDS_SORT_FIELDS = new Set([
  'keyword',
  'relevance',
  'popularity',
  'difficulty',
  'position',
  'lastUpdate',
])
const TRACKED_KEYWORDS_SORT_DEFAULT = 'keyword'
const TRACKED_KEYWORDS_ORDER_VALUES = new Set(['asc', 'desc'])
const TRACKED_KEYWORDS_ORDER_DEFAULT = 'asc'
const SUPPORTED_PLATFORMS = new Set([
  'iphone',
  'ipad',
  'mac',
  'appletv',
  'watch',
  'vision',
])

function print(message = '') {
  process.stdout.write(`${message}\n`)
}

function printError(message = '') {
  process.stderr.write(`${message}\n`)
}

function printJson(payload) {
  print(JSON.stringify(payload))
}

function parseArgs(argv) {
  const args = [...argv]
  return {
    command: args[0] || 'help',
    rest: args.slice(1),
  }
}

function takeOption(rest, name) {
  const index = rest.indexOf(name)

  if (index === -1) {
    return null
  }

  if (index === rest.length - 1) {
    throw new Error(`Missing value for ${name}`)
  }

  const value = rest[index + 1]
  rest.splice(index, 2)
  return value
}

function takeFlag(rest, name) {
  const index = rest.indexOf(name)

  if (index === -1) {
    return false
  }

  rest.splice(index, 1)
  return true
}

async function loadConfig() {
  try {
    const contents = await fs.readFile(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(contents)

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    return parsed
  } catch (_error) {
    return {}
  }
}

async function saveConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })

  // Enforce restrictive permissions even when the file already existed.
  await fs.chmod(CONFIG_PATH, 0o600).catch(() => {})
}

function getAccessToken(config) {
  if (!config || typeof config !== 'object') {
    return null
  }

  const token =
    typeof config.accessToken === 'string' ? config.accessToken.trim() : ''

  if (!token) {
    return null
  }

  return token
}

function normalizePlatform(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (!SUPPORTED_PLATFORMS.has(normalized)) {
    return null
  }
  return normalized
}

function normalizeRegionCode(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()

  if (!/^[A-Z]{2}$/.test(normalized)) {
    return null
  }

  return normalized
}

function parsePeriodValue(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10)

  if (![7, 30, 90].includes(parsed)) {
    return null
  }

  return parsed
}

function parseRegionsOption(value) {
  const raw = String(value || '').trim()

  if (!raw) {
    return []
  }

  const regions = raw
    .split(',')
    .map((entry) => normalizeRegionCode(entry))
    .filter((entry) => entry != null)

  return Array.from(new Set(regions))
}

function normalizePlannedTrackedAppId(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, '')

  if (!normalized) {
    return null
  }

  if (normalized.length > MAX_PLANNED_TRACKED_APP_ID_LENGTH) {
    return null
  }

  return normalized
}

function parseAppInput(value) {
  const trimmed = String(value || '').trim()

  if (!trimmed) {
    return null
  }

  const prefixed = trimmed.match(
    new RegExp(`^id(\\d{${APP_ID_MIN_LENGTH},})$`, 'i'),
  )
  if (prefixed) {
    return { appId: prefixed[1] }
  }

  const raw = trimmed.match(new RegExp(`^(\\d{${APP_ID_MIN_LENGTH},})$`))
  if (raw) {
    return { appId: raw[1] }
  }

  try {
    const parsed = new URL(trimmed)
    const fromPath = parsed.pathname.match(
      new RegExp(`/id(\\d{${APP_ID_MIN_LENGTH},})(?:/|$)`, 'i'),
    )
    if (fromPath) {
      return { appId: fromPath[1] }
    }
  } catch (_error) {
    // ignore invalid URL
  }

  const embedded = trimmed.match(
    new RegExp(`\\bid(\\d{${APP_ID_MIN_LENGTH},})\\b`, 'i'),
  )
  if (embedded) {
    return { appId: embedded[1] }
  }

  return null
}

function consumeAppId(rest, { required = false } = {}) {
  const appOptionValue = takeOption(rest, '--app')
  let appId = null

  if (appOptionValue) {
    const parsed = parseAppInput(appOptionValue)
    if (!parsed) {
      throw new Error(
        'Invalid --app value. Use an App Store URL, id-prefixed value, or numeric id.',
      )
    }
    appId = parsed.appId
  } else if (rest.length > 0) {
    const parsed = parseAppInput(rest[0])
    if (parsed) {
      rest.shift()
      appId = parsed.appId
    }
  }

  if (!appId && required) {
    throw new Error('Provide an app via --app <APP_ID_OR_URL>')
  }

  return appId
}

function consumeTrackedKeywordsAppTarget(rest) {
  const appOptionValue = takeOption(rest, '--app')
  let identifier = null

  if (appOptionValue) {
    identifier = String(appOptionValue).trim()
  } else if (rest.length > 0) {
    const first = String(rest[0] || '').trim()
    if (first && !first.startsWith('--')) {
      rest.shift()
      identifier = first
    }
  }

  if (!identifier) {
    throw new Error('Provide an app via --app <APP_ID_OR_URL_OR_PLANNED_ID>')
  }

  const parsedApp = parseAppInput(identifier)
  if (parsedApp) {
    return {
      appIdentifier: parsedApp.appId,
      appId: parsedApp.appId,
      plannedTrackedAppId: null,
    }
  }

  const plannedId = normalizePlannedTrackedAppId(identifier)
  if (plannedId) {
    return {
      appIdentifier: plannedId,
      appId: null,
      plannedTrackedAppId: plannedId,
    }
  }

  throw new Error(
    'Invalid --app value. Use an App Store URL/id or a planned app id.',
  )
}

function normalizeKeywordArgs(rest) {
  return rest
    .map((value) => String(value || '').trim())
    .map((value) => value.replace(/^["']+|["']+$/g, ''))
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value.length > 0)
}

function toLocalDateOnly(date = new Date()) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return normalized
}

function looksLikeHtml(text) {
  const normalized = text.trim().toLowerCase()
  return (
    normalized.startsWith('<!doctype html') ||
    normalized.startsWith('<html') ||
    normalized.includes('<body')
  )
}

function getResponseOrigin(response) {
  try {
    return new URL(response.url).origin
  } catch (_error) {
    return API_BASE_URL
  }
}

async function parseErrorResponse(response) {
  const text = await response.text().catch(() => '')

  if (!text) {
    return {
      message: `${response.status} ${response.statusText}`,
      payload: null,
    }
  }

  try {
    const parsed = JSON.parse(text)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.error === 'string'
    ) {
      return {
        message: parsed.error,
        payload: parsed,
      }
    }
    return {
      message: text,
      payload: parsed,
    }
  } catch (_error) {
    // ignore parse errors
  }

  if (looksLikeHtml(text)) {
    return {
      message: `Request failed (${response.status} ${response.statusText}). Received HTML response from ${getResponseOrigin(response)}.`,
      payload: null,
    }
  }

  return {
    message: text,
    payload: null,
  }
}

async function apiRequest({ pathName, method = 'GET', body, accessToken }) {
  const url = `${API_BASE_URL}${pathName}`
  const headers = {
    Accept: 'application/json',
  }

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`
  }

  const init = {
    method,
    headers,
  }

  if (body != null) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const response = await fetch(url, init)

  if (!response.ok) {
    const parsedError = await parseErrorResponse(response)
    const error = new Error(parsedError.message)
    error.status = response.status
    error.payload = parsedError.payload
    throw error
  }

  if (response.status === 204) {
    return null
  }

  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  return response.text()
}

function openInBrowser(url) {
  const platform = process.platform

  let command = ''
  let args = []

  if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else if (platform === 'linux') {
    command = 'xdg-open'
    args = [url]
  } else {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('spawn', () => resolve(true))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatDate(iso) {
  if (!iso) {
    return 'n/a'
  }

  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }

  return date.toISOString()
}

function printHelp() {
  print('ASO Suite CLI')
  print('')
  print('Usage:')
  print('  asosuite login [--no-open]')
  print('  asosuite logout')
  print('  asosuite subscription [--json]')
  print(
    '  asosuite search-apps [--json] [--region <REGION>] [--platform <PLATFORM>] <query...>',
  )
  print('  asosuite list-apps [--json]')
  print(
    `  asosuite keywords [--json] [--region <REGION>] [--platform <PLATFORM>] [--app <APP_ID_OR_URL>] <keyword...>`,
  )
  print(
    '  asosuite track-app [--json] [--region <REGION>] [--platform <PLATFORM>] --app <APP_ID_OR_URL>',
  )
  print(
    '  asosuite untrack-app [--json] [--region <REGION>] [--platform <PLATFORM>] --app <APP_ID_OR_URL>',
  )
  print(
    '  asosuite plan-app [--json] --name <APP_NAME> [--id <PLANNED_APP_ID>] [--region <REGION>] [--platform <PLATFORM>]',
  )
  print(
    '  asosuite unplan-app [--json] --id <PLANNED_APP_ID> [--region <REGION>] [--platform <PLATFORM>]',
  )
  print(
    '  asosuite tracked-keywords list [--json] [--region <REGION>] [--platform <PLATFORM>] [--page <NUMBER>] [--sort <FIELD>] [--order <asc|desc>] --app <APP_ID_OR_URL_OR_PLANNED_ID>',
  )
  print(
    '  asosuite tracked-keywords add [--json] [--region <REGION>] [--platform <PLATFORM>] --app <APP_ID_OR_URL_OR_PLANNED_ID> <keyword...>',
  )
  print(
    '  asosuite tracked-keywords remove [--json] [--region <REGION>] [--platform <PLATFORM>] --app <APP_ID_OR_URL_OR_PLANNED_ID> <keyword...>',
  )
  print(
    '  asosuite related-apps list [--json] --app <APP_ID_OR_URL> [--platform <PLATFORM>]',
  )
  print(
    '  asosuite related-apps add [--json] --app <APP_ID_OR_URL> --related <APP_ID_OR_URL> [--platform <PLATFORM>] [--region <REGION>]',
  )
  print(
    '  asosuite related-apps remove [--json] --app <APP_ID_OR_URL> --related <APP_ID_OR_URL> [--platform <PLATFORM>]',
  )
  print('  asosuite events list [--json] [--app <APP_ID_OR_URL>]')
  print(
    '  asosuite events add [--json] --text <TEXT> [--date <YYYY-MM-DD>] [--app <APP_ID_OR_URL>]',
  )
  print('  asosuite events delete [--json] <EVENT_ID>')
  print(
    '  asosuite charts [--json] [--period <7|30|90>] [--region <REGION> | --regions <REGION,REGION>] [--platform <PLATFORM>] --app <APP_ID_OR_URL>',
  )
  print(
    '  asosuite features [--json] [--platform <PLATFORM>] --app <APP_ID_OR_URL>',
  )
  print(
    '  asosuite ratings [--json] [--period <7|30|90>] [--platform <PLATFORM>] --app <APP_ID_OR_URL>',
  )
  print('  asosuite help')
  print('')
  print(`Defaults: region=${DEFAULT_REGION}, platform=${DEFAULT_PLATFORM}`)
  print('Supported platforms: iphone, ipad, mac, appletv, watch, vision')
  print('Output: use --json for single-line JSON output')
  print(
    'tracked-keywords sort fields: keyword, relevance, popularity, difficulty, position, lastUpdate',
  )
  print('')
  print('Examples:')
  print('  asosuite keywords keyword1 keyword2')
  print('  asosuite search-apps --region US --platform iphone "chat gpt"')
  print('  asosuite list-apps')
  print('  asosuite track-app --app 6448311069 --platform iphone --region US')
  print('  asosuite untrack-app --app 6448311069 --platform iphone --region US')
  print(
    '  asosuite plan-app --name "My Next App" --platform iphone --region US',
  )
  print('  asosuite unplan-app --id my-next-app --platform iphone --region US')
  print(
    '  asosuite tracked-keywords add --app 6448311069 --region US "step counter"',
  )
  print(
    '  asosuite tracked-keywords remove --app 6448311069 --region US "step counter"',
  )
  print(
    '  asosuite tracked-keywords remove --app my-next-app --region US "step counter"',
  )
  print('  asosuite related-apps list --app 6448311069 --platform iphone')
  print(
    '  asosuite related-apps add --app 6448311069 --related 333903271 --platform iphone --region US',
  )
  print(
    '  asosuite related-apps remove --app 6448311069 --related 333903271 --platform iphone',
  )
  print('  asosuite events list --app 6448311069')
  print('  asosuite events add --app 6448311069 --text "Release v2.0"')
  print('  asosuite events delete 123')
  print(
    '  asosuite tracked-keywords list --app 6448311069 --platform iphone --page 1 --sort keyword --order asc',
  )
  print(
    '  asosuite tracked-keywords list --app my-next-app --platform iphone --page 1 --sort relevance --order desc',
  )
  print('  asosuite charts --app 6448311069 --platform iphone --period 30')
  print('  asosuite features --app 6448311069 --platform iphone')
  print('  asosuite ratings --app 6448311069 --platform iphone --period 30')
  print(
    '  asosuite keywords --app "https://apps.apple.com/us/app/chatgpt/id6448311069" --platform iphone "ai assistant"',
  )
}

async function runAuthLogin(rest) {
  const noOpen = takeFlag(rest, '--no-open')

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const start = await apiRequest({
    pathName: '/api/cli/auth/start',
    method: 'POST',
  })

  const userCode = String(start.userCode || '').trim()
  const verificationUrl = `${WEB_BASE_URL}/cli/auth?code=${encodeURIComponent(userCode)}`
  const deviceCode = String(start.deviceCode || '').trim()
  const pollIntervalSeconds =
    Number(start.pollIntervalSeconds) > 0
      ? Number(start.pollIntervalSeconds)
      : DEFAULT_POLL_INTERVAL_SECONDS
  const expiresInSeconds =
    Number(start.expiresInSeconds) > 0 ? Number(start.expiresInSeconds) : 600

  if (!deviceCode || !verificationUrl || !userCode) {
    throw new Error('Server returned an invalid authentication payload')
  }

  print('To authenticate, open:')
  print(`  ${verificationUrl}`)
  print(`Code: ${userCode}`)

  if (!noOpen) {
    try {
      const opened = await openInBrowser(verificationUrl)
      if (opened) {
        print('Opened browser for authentication.')
      } else {
        print(
          'Could not open browser automatically. Open the URL above manually.',
        )
      }
    } catch (_error) {
      print(
        'Could not open browser automatically. Open the URL above manually.',
      )
    }
  }

  print('Waiting for approval...')

  const deadline = Date.now() + expiresInSeconds * 1000

  while (Date.now() < deadline) {
    try {
      const tokenResponse = await apiRequest({
        pathName: '/api/cli/auth/token',
        method: 'POST',
        body: { deviceCode },
      })

      const accessToken = String(tokenResponse.accessToken || '').trim()
      const expiresAt = String(tokenResponse.expiresAt || '').trim()

      if (!accessToken || !expiresAt) {
        throw new Error('Server returned an invalid token response')
      }

      await saveConfig({
        accessToken,
        expiresAt,
      })

      print('Authenticated successfully.')
      print(`Token expires at: ${formatDate(expiresAt)}`)
      print(`Stored config: ${CONFIG_PATH}`)
      return
    } catch (error) {
      const status = Number(error?.status || 0)

      if (status === 428) {
        await sleep(pollIntervalSeconds * 1000)
        continue
      }

      if (status === 410) {
        throw new Error(
          'Authorization request expired. Run `asosuite login` again.',
        )
      }

      if (status === 409 || status === 400) {
        throw new Error(
          'Authorization request is no longer valid. Run `asosuite login` again.',
        )
      }

      throw error
    }
  }

  throw new Error('Authentication timed out. Run `asosuite login` again.')
}

async function runAuthLogout() {
  await saveConfig({})
  print(`Cleared local credentials from ${CONFIG_PATH}`)
}

function requireAuthenticatedAccessToken(config) {
  const accessToken = getAccessToken(config)

  if (!accessToken) {
    throw new Error('Not authenticated. Run `asosuite login` first.')
  }

  return accessToken
}

async function runSubscriptionStatus(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)

  const subscription = await apiRequest({
    pathName: '/api/cli/subscription',
    accessToken,
  })

  if (outputJson) {
    printJson(subscription)
    return
  }

  print(`Plan: ${subscription.plan}`)
  print(`Active: ${subscription.active ? 'yes' : 'no'}`)
  print(`Subscriber: ${subscription.isSubscriber ? 'yes' : 'no'}`)
  print(`Billing period: ${subscription.billingPeriod || 'n/a'}`)
  print(`Expires at: ${formatDate(subscription.expiresAt)}`)

  if (!subscription.isSubscriber && subscription.subscribeUrl) {
    print('')
    print(`Subscribe: ${subscription.subscribeUrl}`)
  }
}

function formatMetricValue(value, pending) {
  if (pending) {
    return 'pending'
  }

  if (typeof value !== 'number') {
    return 'n/a'
  }

  return String(value)
}

function formatPositionValue(position) {
  if (typeof position !== 'number') {
    return '-'
  }

  return `#${position}`
}

function printTable(headers, rows) {
  const widths = headers.map((header) => header.length)

  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      widths[index] = Math.max(widths[index], String(row[index]).length)
    }
  }

  const formatRow = (row) =>
    row
      .map((cell, index) =>
        index === 0
          ? String(cell).padEnd(widths[index])
          : String(cell).padStart(widths[index]),
      )
      .join('  ')

  print(formatRow(headers))
  print(widths.map((width) => '-'.repeat(width)).join('  '))

  for (const row of rows) {
    print(formatRow(row))
  }
}

function printKeywordMetricsTable(metrics, options = { showPosition: false }) {
  const showPosition = Boolean(options.showPosition)
  const headers = showPosition
    ? ['Keyword', 'Popularity', 'Difficulty', 'Position']
    : ['Keyword', 'Popularity', 'Difficulty']

  const rows = metrics.map((metric) => {
    const base = [
      metric.keyword,
      formatMetricValue(metric.popularity, metric.popularityPending),
      formatMetricValue(metric.difficulty, metric.difficultyPending),
    ]

    if (showPosition) {
      base.push(formatPositionValue(metric.position))
    }

    return base
  })

  printTable(headers, rows)
}

async function runKeywordMetrics(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const regionValue = takeOption(rest, '--region')
  const platformValue = takeOption(rest, '--platform')
  const appId = consumeAppId(rest, { required: false })
  const keywords = normalizeKeywordArgs(rest)

  if (keywords.length === 0) {
    throw new Error('Provide at least one keyword')
  }

  if (keywords.length > MAX_KEYWORDS) {
    throw new Error(`At most ${MAX_KEYWORDS} keywords are allowed per request`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)

  const region = (regionValue ?? DEFAULT_REGION).trim().toUpperCase()
  const platform =
    platformValue == null ? DEFAULT_PLATFORM : normalizePlatform(platformValue)

  if (!platform) {
    throw new Error(
      `Invalid --platform value. Supported values: ${Array.from(SUPPORTED_PLATFORMS).join(', ')}`,
    )
  }

  const response = await apiRequest({
    pathName: '/api/cli/keywords/metrics',
    method: 'POST',
    accessToken,
    body: {
      region,
      keywords,
      appId,
      platform,
    },
  })

  if (outputJson) {
    printJson(response)
    return
  }

  print(`Region: ${response.region}`)
  print(`Keywords: ${response.keywordCount}`)
  if (response.appId) {
    print(`App ID: ${response.appId}`)
    print(`Platform: ${response.platform}`)
  }
  print('')
  printKeywordMetricsTable(
    Array.isArray(response.metrics) ? response.metrics : [],
    {
      showPosition: Boolean(response.appId),
    },
  )
}

function formatTrendValue(value) {
  if (typeof value !== 'number') {
    return '-'
  }

  if (value > 0) {
    return `+${value}`
  }

  return String(value)
}

function formatRankingListLabel(list) {
  const chart = typeof list?.chart === 'string' ? list.chart : null

  if (typeof list?.category === 'string' && list.category) {
    return chart ? `${list.category} (${chart})` : list.category
  }

  if (typeof list?.collection === 'string' && list.collection) {
    return list.collection
  }

  return chart || 'unknown'
}

function extractTrackedKeywordApps(payload) {
  if (payload && typeof payload === 'object' && Array.isArray(payload.apps)) {
    return payload.apps
  }

  if (Array.isArray(payload)) {
    return payload
  }

  return []
}

function resolvePlatformArg(value) {
  const platform = value == null ? DEFAULT_PLATFORM : normalizePlatform(value)

  if (!platform) {
    throw new Error(
      `Invalid --platform value. Supported values: ${Array.from(SUPPORTED_PLATFORMS).join(', ')}`,
    )
  }

  return platform
}

function resolveRegionArg(value, optionName = '--region') {
  const region = value == null ? DEFAULT_REGION : normalizeRegionCode(value)

  if (!region) {
    throw new Error(`Invalid ${optionName} value. Use a 2-letter region code.`)
  }

  return region
}

function resolveOptionalRegionArg(value, optionName = '--region') {
  if (value == null) {
    return null
  }

  const region = normalizeRegionCode(value)

  if (!region) {
    throw new Error(`Invalid ${optionName} value. Use a 2-letter region code.`)
  }

  return region
}

function resolveTrackedKeywordsPageArg(value) {
  if (value == null) {
    return 1
  }

  const parsed = Number.parseInt(String(value), 10)
  if (
    !Number.isFinite(parsed) ||
    parsed < 1 ||
    parsed > TRACKED_KEYWORDS_MAX_PAGE
  ) {
    throw new Error(
      `Invalid --page value. Use an integer between 1 and ${TRACKED_KEYWORDS_MAX_PAGE}.`,
    )
  }

  return parsed
}

function resolveTrackedKeywordsSortArg(value) {
  if (value == null) {
    return TRACKED_KEYWORDS_SORT_DEFAULT
  }

  const normalized = String(value).trim().toLowerCase()
  const canonical = normalized === 'lastupdate' ? 'lastUpdate' : normalized

  if (!TRACKED_KEYWORDS_SORT_FIELDS.has(canonical)) {
    throw new Error(
      `Invalid --sort value. Supported values: ${Array.from(TRACKED_KEYWORDS_SORT_FIELDS).join(', ')}`,
    )
  }

  return canonical
}

function resolveTrackedKeywordsOrderArg(value) {
  if (value == null) {
    return TRACKED_KEYWORDS_ORDER_DEFAULT
  }

  const normalized = String(value).trim().toLowerCase()
  if (!TRACKED_KEYWORDS_ORDER_VALUES.has(normalized)) {
    throw new Error('Invalid --order value. Supported values: asc, desc')
  }

  return normalized
}

async function runSearchApps(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')
  const unknownFlags = rest.filter((value) =>
    String(value || '').startsWith('--'),
  )

  if (unknownFlags.length > 0) {
    throw new Error(`Unknown arguments: ${unknownFlags.join(' ')}`)
  }

  const query = rest
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!query) {
    throw new Error('Provide a search query')
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveRegionArg(regionValue)

  const payload = await apiRequest({
    pathName: '/api/cli/apps/search',
    method: 'POST',
    accessToken,
    body: {
      query,
      platform,
      region,
    },
  })

  if (outputJson) {
    printJson(payload)
    return
  }

  const apps = Array.isArray(payload) ? payload : []

  print(`Query: ${query}`)
  print(`Platform: ${platform}`)
  print(`Region: ${region}`)
  print(`Results: ${apps.length}`)

  if (apps.length === 0) {
    return
  }

  print('')

  const rows = apps.map((app) => [
    app.appId || '-',
    app.isTracked ? 'yes' : 'no',
    Array.isArray(app.trackedRegions) && app.trackedRegions.length > 0
      ? app.trackedRegions.join(',')
      : '-',
    app.name || '-',
    app.developer || '-',
  ])

  printTable(
    ['App ID', 'Tracked', 'Tracked Regions', 'Name', 'Developer'],
    rows,
  )
}

async function runListApps(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const payload = await apiRequest({
    pathName: '/api/cli/apps/list',
    accessToken,
  })

  if (outputJson) {
    printJson(payload)
    return
  }

  const tracked = Array.isArray(payload?.tracked) ? payload.tracked : []
  const planned = Array.isArray(payload?.planned) ? payload.planned : []

  print(`Tracked apps: ${tracked.length}`)
  print(`Planned apps: ${planned.length}`)

  if (tracked.length > 0) {
    print('')
    print('Tracked:')

    const trackedRows = tracked.map((entry) => [
      entry.appId || '-',
      entry.platform || '-',
      Array.isArray(entry.regions)
        ? entry.regions.map((region) => region.region).join(',')
        : '-',
      String(entry.totalKeywordCount ?? 0),
      entry.name || '-',
    ])

    printTable(
      ['App ID', 'Platform', 'Regions', 'Keywords', 'Name'],
      trackedRows,
    )
  }

  if (planned.length > 0) {
    print('')
    print('Planned:')

    const plannedRows = planned.map((entry) => [
      entry.plannedTrackedAppId || '-',
      entry.platform || '-',
      Array.isArray(entry.regions)
        ? entry.regions.map((region) => region.region).join(',')
        : '-',
      String(entry.totalKeywordCount ?? 0),
      entry.name || '-',
    ])

    printTable(
      ['Planned ID', 'Platform', 'Regions', 'Keywords', 'Name'],
      plannedRows,
    )
  }
}

function parseRequiredAppId(value, optionName) {
  const parsed = parseAppInput(value)

  if (!parsed) {
    throw new Error(
      `Invalid ${optionName} value. Use an App Store URL, id-prefixed value, or numeric id.`,
    )
  }

  return parsed.appId
}

async function runRelatedApps(rest) {
  const subcommand = String(rest.shift() || '')
    .trim()
    .toLowerCase()

  if (!subcommand) {
    throw new Error('Provide a subcommand: related-apps <list|add|remove> ...')
  }

  if (subcommand === 'list') {
    await runRelatedAppsList(rest)
    return
  }

  if (subcommand === 'add') {
    await runRelatedAppsAdd(rest)
    return
  }

  if (subcommand === 'remove') {
    await runRelatedAppsRemove(rest)
    return
  }

  throw new Error(
    `Unknown related-apps subcommand: ${subcommand}. Use list, add, or remove.`,
  )
}

async function runRelatedAppsList(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const appId = consumeAppId(rest, { required: true })

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const payload = await apiRequest({
    pathName: `/api/cli/apps/${encodeURIComponent(appId)}/${platform}/related-apps`,
    accessToken,
  })

  if (outputJson) {
    printJson(payload)
    return
  }

  const relatedApps = Array.isArray(payload) ? payload : []

  print(`App ID: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Related apps: ${relatedApps.length}`)

  if (relatedApps.length === 0) {
    return
  }

  print('')
  printTable(
    ['App ID', 'Platform', 'Icon'],
    relatedApps.map((entry) => [
      entry.appId || '-',
      entry.platform || '-',
      entry.iconUrl || '-',
    ]),
  )
}

async function runRelatedAppsAdd(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const relatedValue = takeOption(rest, '--related')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')
  const appId = consumeAppId(rest, { required: true })

  if (!relatedValue) {
    throw new Error('Provide a related app via --related <APP_ID_OR_URL>')
  }

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const relatedAppId = parseRequiredAppId(relatedValue, '--related')
  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveOptionalRegionArg(regionValue)

  await apiRequest({
    pathName: `/api/cli/apps/${encodeURIComponent(appId)}/${platform}/related-apps`,
    method: 'POST',
    accessToken,
    body: {
      relatedAppId,
      ...(region ? { region } : {}),
    },
  })

  if (outputJson) {
    printJson({
      ok: true,
      appId,
      platform,
      relatedAppId,
      ...(region ? { region } : {}),
    })
    return
  }

  print(`Base app: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Added related app: ${relatedAppId}`)
  if (region) {
    print(`Region: ${region}`)
  }
}

async function runRelatedAppsRemove(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const relatedValue = takeOption(rest, '--related')
  const platformValue = takeOption(rest, '--platform')
  const appId = consumeAppId(rest, { required: true })

  if (!relatedValue) {
    throw new Error('Provide a related app via --related <APP_ID_OR_URL>')
  }

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const relatedAppId = parseRequiredAppId(relatedValue, '--related')
  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)

  await apiRequest({
    pathName: `/api/cli/apps/${encodeURIComponent(appId)}/${platform}/related-apps`,
    method: 'DELETE',
    accessToken,
    body: {
      relatedAppId,
    },
  })

  if (outputJson) {
    printJson({
      ok: true,
      appId,
      platform,
      relatedAppId,
    })
    return
  }

  print(`Base app: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Removed related app: ${relatedAppId}`)
}

async function runEvents(rest) {
  const subcommand = String(rest.shift() || '')
    .trim()
    .toLowerCase()

  if (!subcommand) {
    throw new Error('Provide a subcommand: events <list|add|delete> ...')
  }

  if (subcommand === 'list') {
    await runEventsList(rest)
    return
  }

  if (subcommand === 'add') {
    await runEventsAdd(rest)
    return
  }

  if (subcommand === 'delete') {
    await runEventsDelete(rest)
    return
  }

  throw new Error(
    `Unknown events subcommand: ${subcommand}. Use list, add, or delete.`,
  )
}

async function runEventsList(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const appOptionValue = takeOption(rest, '--app')

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const appId = appOptionValue
    ? parseRequiredAppId(appOptionValue, '--app')
    : null
  const searchParams = new URLSearchParams()

  if (appId) {
    searchParams.set('appId', appId)
  }

  const query = searchParams.toString()
  const payload = await apiRequest({
    pathName: `/api/cli/events${query ? `?${query}` : ''}`,
    accessToken,
  })

  if (outputJson) {
    printJson(payload)
    return
  }

  const events = Array.isArray(payload) ? payload : []

  print(`Events: ${events.length}`)
  if (appId) {
    print(`App filter: ${appId} (including global events)`)
  }

  if (events.length === 0) {
    return
  }

  print('')
  printTable(
    ['ID', 'Date', 'Scope', 'App ID', 'Text'],
    events.map((event) => [
      String(event.id ?? '-'),
      event.date || '-',
      event.appId ? 'app' : 'global',
      event.appId || '-',
      event.text || '-',
    ]),
  )
}

async function runEventsAdd(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const textValue = takeOption(rest, '--text')
  const dateValue = takeOption(rest, '--date')
  const appOptionValue = takeOption(rest, '--app')

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const text = String(textValue || '').trim()

  if (!text) {
    throw new Error('Provide event text via --text <TEXT>')
  }

  const date =
    dateValue == null ? toLocalDateOnly() : normalizeDateOnly(dateValue)

  if (!date) {
    throw new Error('Invalid --date value. Use YYYY-MM-DD.')
  }

  const appId = appOptionValue
    ? parseRequiredAppId(appOptionValue, '--app')
    : null
  const accessToken = requireAuthenticatedAccessToken(config)
  const payload = await apiRequest({
    pathName: '/api/cli/events',
    method: 'POST',
    accessToken,
    body: {
      date,
      text,
      ...(appId ? { appId } : {}),
    },
  })

  if (outputJson) {
    printJson(payload)
    return
  }

  print(`Added event: ${payload?.id ?? 'ok'}`)
  print(`Date: ${payload?.date || date}`)
  print(`Scope: ${payload?.appId ? `app (${payload.appId})` : 'global'}`)
  print(`Text: ${payload?.text || text}`)
}

async function runEventsDelete(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')

  if (rest.length !== 1) {
    throw new Error('Provide an event id: events delete <EVENT_ID>')
  }

  const id = Number.parseInt(String(rest[0]).trim(), 10)
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Invalid event id. Use a positive integer.')
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  await apiRequest({
    pathName: `/api/cli/events/${id}`,
    method: 'DELETE',
    accessToken,
  })

  if (outputJson) {
    printJson({
      ok: true,
      id,
    })
    return
  }

  print(`Deleted event: ${id}`)
}

async function runTrackApp(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')
  const appId = consumeAppId(rest, { required: true })

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveRegionArg(regionValue)

  await apiRequest({
    pathName: '/api/cli/apps/track',
    method: 'POST',
    accessToken,
    body: {
      appId,
      platform,
      region,
    },
  })

  if (outputJson) {
    printJson({
      ok: true,
      appId,
      platform,
      region,
    })
    return
  }

  print(`Tracked app: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Region: ${region}`)
}

async function runUntrackApp(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')
  const appId = consumeAppId(rest, { required: true })

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveRegionArg(regionValue)

  await apiRequest({
    pathName: '/api/cli/apps/track',
    method: 'DELETE',
    accessToken,
    body: {
      appId,
      platform,
      region,
    },
  })

  if (outputJson) {
    printJson({
      ok: true,
      appId,
      platform,
      region,
    })
    return
  }

  print(`Untracked app: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Region: ${region}`)
}

async function runPlanApp(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const nameValue = takeOption(rest, '--name')
  const plannedTrackedAppIdValue = takeOption(rest, '--id')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const name = String(nameValue || '').trim()

  if (!name) {
    throw new Error('Provide a name via --name <APP_NAME>')
  }

  const plannedTrackedAppId = normalizePlannedTrackedAppId(
    plannedTrackedAppIdValue,
  )

  if (plannedTrackedAppIdValue != null && !plannedTrackedAppId) {
    throw new Error(
      `Invalid --id value. Planned app ids must be 1-${MAX_PLANNED_TRACKED_APP_ID_LENGTH} chars.`,
    )
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveRegionArg(regionValue)

  const body = {
    name,
    platform,
    region,
  }

  if (plannedTrackedAppId) {
    body.plannedTrackedAppId = plannedTrackedAppId
  }

  await apiRequest({
    pathName: '/api/cli/apps/planned',
    method: 'POST',
    accessToken,
    body,
  })

  if (outputJson) {
    printJson({
      ok: true,
      name,
      platform,
      region,
      ...(plannedTrackedAppId ? { plannedTrackedAppId } : {}),
    })
    return
  }

  print(`Planned app: ${name}`)
  print(`Platform: ${platform}`)
  print(`Region: ${region}`)
  if (plannedTrackedAppId) {
    print(`Planned ID: ${plannedTrackedAppId}`)
  }
}

async function runUnplanApp(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const plannedTrackedAppIdValue = takeOption(rest, '--id')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const plannedTrackedAppId = normalizePlannedTrackedAppId(
    plannedTrackedAppIdValue,
  )

  if (!plannedTrackedAppId) {
    throw new Error('Provide a planned app id via --id <PLANNED_APP_ID>')
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveRegionArg(regionValue)

  await apiRequest({
    pathName: '/api/cli/apps/planned',
    method: 'DELETE',
    accessToken,
    body: {
      plannedTrackedAppId,
      platform,
      region,
    },
  })

  if (outputJson) {
    printJson({
      ok: true,
      plannedTrackedAppId,
      platform,
      region,
    })
    return
  }

  print(`Unplanned app: ${plannedTrackedAppId}`)
  print(`Platform: ${platform}`)
  print(`Region: ${region}`)
}

async function runTrackedKeywords(rest) {
  const subcommand = String(rest.shift() || '')
    .trim()
    .toLowerCase()

  // Backward compatibility for: tracked-keywords --app ...
  if (!subcommand || subcommand.startsWith('--')) {
    if (subcommand) {
      rest.unshift(subcommand)
    }
    await runTrackedKeywordsList(rest)
    return
  }

  if (subcommand === 'list') {
    await runTrackedKeywordsList(rest)
    return
  }

  if (subcommand === 'add') {
    await runTrackedKeywordsAdd(rest)
    return
  }

  if (subcommand === 'remove') {
    await runTrackedKeywordsRemove(rest)
    return
  }

  if (parseAppInput(subcommand) || normalizePlannedTrackedAppId(subcommand)) {
    rest.unshift(subcommand)
    await runTrackedKeywordsList(rest)
    return
  }

  throw new Error(
    `Unknown tracked-keywords subcommand: ${subcommand}. Use list, add, or remove.`,
  )
}

async function runTrackedKeywordsAdd(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')
  const target = consumeTrackedKeywordsAppTarget(rest)
  const keywords = normalizeKeywordArgs(rest)

  if (keywords.length === 0) {
    throw new Error('Provide at least one keyword')
  }

  if (keywords.length > MAX_TRACKED_KEYWORDS_ADD) {
    throw new Error(
      `At most ${MAX_TRACKED_KEYWORDS_ADD} keywords are allowed per request`,
    )
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveRegionArg(regionValue)
  const isPlannedTarget = !target.appId

  const pathName = isPlannedTarget
    ? '/api/cli/apps/planned/keywords'
    : '/api/cli/apps/keywords'
  const body = isPlannedTarget
    ? {
        plannedTrackedAppId: target.plannedTrackedAppId,
        platform,
        region,
        keywords,
      }
    : {
        appId: target.appId,
        platform,
        region,
        keywords,
      }

  await apiRequest({
    pathName,
    method: 'POST',
    accessToken,
    body,
  })

  if (outputJson) {
    printJson({
      ok: true,
      platform,
      region,
      keywordCount: keywords.length,
      keywords,
      ...(isPlannedTarget
        ? { plannedTrackedAppId: target.plannedTrackedAppId }
        : { appId: target.appId }),
    })
    return
  }

  print(`Added keywords: ${keywords.length}`)
  print(
    isPlannedTarget
      ? `Planned ID: ${target.plannedTrackedAppId}`
      : `App ID: ${target.appId}`,
  )
  print(`Platform: ${platform}`)
  print(`Region: ${region}`)
}

async function runTrackedKeywordsRemove(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')
  const target = consumeTrackedKeywordsAppTarget(rest)
  const keywords = normalizeKeywordArgs(rest)

  if (keywords.length === 0) {
    throw new Error('Provide at least one keyword')
  }

  if (keywords.length > MAX_TRACKED_KEYWORDS_ADD) {
    throw new Error(
      `At most ${MAX_TRACKED_KEYWORDS_ADD} keywords are allowed per request`,
    )
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveRegionArg(regionValue)
  const isPlannedTarget = !target.appId

  const pathName = isPlannedTarget
    ? '/api/cli/apps/planned/keywords'
    : '/api/cli/apps/keywords'
  const body = isPlannedTarget
    ? {
        plannedTrackedAppId: target.plannedTrackedAppId,
        platform,
        region,
        keywords,
      }
    : {
        appId: target.appId,
        platform,
        region,
        keywords,
      }

  await apiRequest({
    pathName,
    method: 'DELETE',
    accessToken,
    body,
  })

  if (outputJson) {
    printJson({
      ok: true,
      platform,
      region,
      keywordCount: keywords.length,
      keywords,
      ...(isPlannedTarget
        ? { plannedTrackedAppId: target.plannedTrackedAppId }
        : { appId: target.appId }),
    })
    return
  }

  print(`Removed keywords: ${keywords.length}`)
  print(
    isPlannedTarget
      ? `Planned ID: ${target.plannedTrackedAppId}`
      : `App ID: ${target.appId}`,
  )
  print(`Platform: ${platform}`)
  print(`Region: ${region}`)
}

async function runTrackedKeywordsList(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const regionValue = takeOption(rest, '--region')
  const pageValue = takeOption(rest, '--page')
  const sortValue = takeOption(rest, '--sort')
  const orderValue = takeOption(rest, '--order')
  const target = consumeTrackedKeywordsAppTarget(rest)

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const region = resolveOptionalRegionArg(regionValue)
  const page = resolveTrackedKeywordsPageArg(pageValue)
  const sort = resolveTrackedKeywordsSortArg(sortValue)
  const order = resolveTrackedKeywordsOrderArg(orderValue)

  const searchParams = new URLSearchParams()
  if (region) {
    searchParams.set('region', region)
  }
  searchParams.set('page', String(page))
  searchParams.set('sort', sort)
  searchParams.set('order', order)

  const query = searchParams.toString()
  const response = await apiRequest({
    pathName: `/api/cli/apps/${encodeURIComponent(target.appIdentifier)}/${platform}/tracked-keywords${query ? `?${query}` : ''}`,
    accessToken,
  })

  if (outputJson) {
    printJson(response)
    return
  }

  if (
    response &&
    typeof response === 'object' &&
    Array.isArray(response.items)
  ) {
    const appId = typeof response.appId === 'string' ? response.appId : ''
    const responsePlatform =
      typeof response.platform === 'string' ? response.platform : platform
    const pageValueResolved =
      typeof response.page === 'number' ? response.page : page
    const pageSize =
      typeof response.pageSize === 'number' ? response.pageSize : 50
    const total = typeof response.total === 'number' ? response.total : 0
    const hasMore = Boolean(response.hasMore)
    const regionFilter =
      typeof response.regionFilter === 'string' ? response.regionFilter : null
    const responseSort =
      typeof response.sort === 'string' ? response.sort : sort
    const responseOrder =
      typeof response.order === 'string' ? response.order : order
    const items = response.items

    print(`App ID: ${appId}`)
    print(`Platform: ${responsePlatform}`)
    print(`Region: ${regionFilter || 'all'}`)
    print(`Page: ${pageValueResolved}`)
    print(`Page Size: ${pageSize}`)
    print(`Sort: ${responseSort} ${responseOrder}`)
    print(`Total: ${total}`)
    print(`Has More: ${hasMore}`)

    if (items.length === 0) {
      print('')
      print('No tracked keywords found.')
      return
    }

    const keywordRows = items.map((item) => {
      const rankings = item?.metrics?.rankings?.entries || []
      const latestPosition =
        rankings.length > 0 ? rankings[rankings.length - 1]?.position : null

      return [
        item.keyword || '-',
        item.region || '-',
        formatMetricValue(
          item?.metrics?.popularity?.value,
          item?.metrics?.popularity?.pendingData,
        ),
        formatMetricValue(
          item?.metrics?.difficulty?.value,
          item?.metrics?.difficulty?.pendingData,
        ),
        formatPositionValue(latestPosition),
      ]
    })

    print('')
    printTable(
      ['Keyword', 'Region', 'Popularity', 'Difficulty', 'Position'],
      keywordRows,
    )
    return
  }

  const apps = extractTrackedKeywordApps(response)

  if (apps.length === 0) {
    print('No tracked keywords found.')
    return
  }

  const app = apps[0]
  print(`App ID: ${app.appId}`)
  print(`Platform: ${app.platform}`)
  print(`Regions: ${Array.isArray(app.regions) ? app.regions.length : 0}`)
  print('')

  for (const regionEntry of app.regions || []) {
    const keywordRows = (regionEntry.keywords || []).map((keyword) => {
      const rankings = keyword?.metrics?.rankings?.entries || []
      const latestPosition =
        rankings.length > 0 ? rankings[rankings.length - 1]?.position : null

      return [
        keyword.name,
        formatMetricValue(
          keyword?.metrics?.popularity?.value,
          keyword?.metrics?.popularity?.pendingData,
        ),
        formatMetricValue(
          keyword?.metrics?.difficulty?.value,
          keyword?.metrics?.difficulty?.pendingData,
        ),
        formatPositionValue(latestPosition),
      ]
    })

    print(
      `Region ${regionEntry.code}${regionEntry.name ? ` (${regionEntry.name})` : ''}: ${regionEntry.keywords.length} keywords`,
    )

    if (keywordRows.length === 0) {
      print('  No keywords tracked.')
      print('')
      continue
    }

    printTable(['Keyword', 'Popularity', 'Difficulty', 'Position'], keywordRows)
    print('')
  }
}

async function runRankings(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const periodValue = takeOption(rest, '--period')
  const regionsValue = takeOption(rest, '--regions')
  const regionValue = takeOption(rest, '--region')
  const appId = consumeAppId(rest, { required: true })

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  if (regionsValue != null && regionValue != null) {
    throw new Error('Use either --region or --regions, not both')
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const period =
    periodValue == null ? DEFAULT_PERIOD : parsePeriodValue(periodValue)

  if (!period) {
    throw new Error('Invalid --period value. Allowed values: 7, 30, 90')
  }

  let regions = []

  if (regionsValue != null) {
    regions = parseRegionsOption(regionsValue)
    if (regions.length === 0) {
      throw new Error(
        'Invalid --regions value. Use comma-separated region codes.',
      )
    }
  } else if (regionValue != null) {
    const region = normalizeRegionCode(regionValue)
    if (!region) {
      throw new Error('Invalid --region value. Use a 2-letter region code.')
    }
    regions = [region]
  }

  const response = await apiRequest({
    pathName: `/api/cli/apps/${encodeURIComponent(appId)}/${platform}/charts`,
    method: 'POST',
    accessToken,
    body: {
      period,
      ...(regions.length > 0 ? { regions } : {}),
    },
  })

  if (outputJson) {
    printJson(response)
    return
  }

  const lists = Array.isArray(response?.lists) ? response.lists : []

  print(`App ID: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Period: ${period} days`)
  print(`Lists: ${lists.length}`)
  if (response?.lastUpdate) {
    print(`Last update: ${formatDate(response.lastUpdate)}`)
  }

  if (lists.length === 0) {
    return
  }

  print('')

  const rows = lists.map((entry) => {
    const rankings = Array.isArray(entry?.rankings) ? entry.rankings : []
    const latestPosition =
      rankings.length > 0 ? rankings[rankings.length - 1]?.position : null

    return [
      entry.region || '-',
      formatRankingListLabel(entry),
      formatPositionValue(latestPosition),
      String(rankings.length),
      entry.pendingData ? 'yes' : 'no',
    ]
  })

  printTable(['Region', 'List', 'Latest', 'Points', 'Pending'], rows)
}

async function runFeatured(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const appId = consumeAppId(rest, { required: true })

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)

  const payload = await apiRequest({
    pathName: `/api/cli/apps/${encodeURIComponent(appId)}/${platform}/features`,
    accessToken,
  })

  if (outputJson) {
    printJson(payload)
    return
  }

  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : []
  const remainingCount =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Number(payload.remainingCount || 0)
      : 0

  print(`App ID: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Feature items: ${items.length}`)
  if (remainingCount > 0) {
    print(`Locked items: ${remainingCount}`)
  }

  if (items.length === 0) {
    return
  }

  print('')

  const rows = items.map((item) => {
    const pathParts = Array.isArray(item.path) ? [...item.path] : []
    if (typeof item.name === 'string' && item.name.trim()) {
      pathParts.push(item.name.trim())
    }

    return [
      item.region || '-',
      item.platform || '-',
      formatPositionValue(item.position),
      item.firstSeen ? formatDate(item.firstSeen) : '-',
      formatDate(item.lastSeen),
      pathParts.length > 0 ? pathParts.join(' / ') : '-',
    ]
  })

  printTable(
    ['Region', 'Platform', 'Position', 'First Seen', 'Last Seen', 'Path'],
    rows,
  )
}

async function runRatings(rest) {
  const config = await loadConfig()
  const outputJson = takeFlag(rest, '--json')
  const platformValue = takeOption(rest, '--platform')
  const periodValue = takeOption(rest, '--period')
  const appId = consumeAppId(rest, { required: true })

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = requireAuthenticatedAccessToken(config)
  const platform = resolvePlatformArg(platformValue)
  const period =
    periodValue == null ? DEFAULT_PERIOD : parsePeriodValue(periodValue)

  if (!period) {
    throw new Error('Invalid --period value. Allowed values: 7, 30, 90')
  }

  const payload = await apiRequest({
    pathName: `/api/cli/apps/${encodeURIComponent(appId)}/${platform}/ratings`,
    method: 'POST',
    accessToken,
    body: {
      period,
    },
  })

  if (outputJson) {
    printJson(payload)
    return
  }

  const series = Array.isArray(payload?.series) ? payload.series : []
  const regions = Array.isArray(payload?.regions) ? payload.regions : []
  const latestSeries = series.length > 0 ? series[series.length - 1] : null

  print(`App ID: ${appId}`)
  print(`Platform: ${platform}`)
  print(`Period: ${period} days`)
  print(`Last update: ${formatDate(payload?.lastUpdate)}`)
  print(`Series points: ${series.length}`)

  if (latestSeries) {
    const average =
      typeof latestSeries.average === 'number' ? latestSeries.average : 'n/a'
    print(
      `Latest day: ${latestSeries.date} (average=${average}, count=${latestSeries.count})`,
    )
  }

  if (regions.length === 0) {
    return
  }

  print('')

  const rows = regions.map((entry) => [
    entry.region || '-',
    String(entry.totalCount ?? 0),
    typeof entry.average === 'number' ? String(entry.average) : 'n/a',
    formatTrendValue(entry.trend),
    formatDate(entry.lastUpdate),
  ])

  printTable(['Region', 'Total', 'Average', 'Trend', 'Last Update'], rows)
}

async function run() {
  const { command, rest } = parseArgs(process.argv.slice(2))

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'login') {
    await runAuthLogin(rest)
    return
  }

  if (command === 'logout') {
    await runAuthLogout()
    return
  }

  if (command === 'subscription') {
    await runSubscriptionStatus(rest)
    return
  }

  if (command === 'search-apps') {
    await runSearchApps(rest)
    return
  }

  if (command === 'list-apps') {
    await runListApps(rest)
    return
  }

  if (command === 'keywords') {
    await runKeywordMetrics(rest)
    return
  }

  if (command === 'track-app') {
    await runTrackApp(rest)
    return
  }

  if (command === 'untrack-app') {
    await runUntrackApp(rest)
    return
  }

  if (command === 'plan-app') {
    await runPlanApp(rest)
    return
  }

  if (command === 'unplan-app') {
    await runUnplanApp(rest)
    return
  }

  if (command === 'add-keywords') {
    await runTrackedKeywordsAdd(rest)
    return
  }

  if (command === 'remove-keywords') {
    await runTrackedKeywordsRemove(rest)
    return
  }

  if (command === 'remove-planned-keywords') {
    const plannedTrackedAppId = takeOption(rest, '--id')

    if (!plannedTrackedAppId) {
      throw new Error('Provide a planned app id via --id <PLANNED_APP_ID>')
    }

    rest.push('--app', plannedTrackedAppId)
    await runTrackedKeywordsRemove(rest)
    return
  }

  if (command === 'related-apps') {
    await runRelatedApps(rest)
    return
  }

  if (command === 'events') {
    await runEvents(rest)
    return
  }

  if (command === 'tracked-keywords') {
    await runTrackedKeywords(rest)
    return
  }

  if (command === 'charts') {
    await runRankings(rest)
    return
  }

  if (command === 'features') {
    await runFeatured(rest)
    return
  }

  if (command === 'ratings') {
    await runRatings(rest)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

run().catch((error) => {
  const status = Number(error?.status || 0)

  if (status === 401) {
    printError('Authentication failed. Run `asosuite login` again.')
    process.exit(1)
    return
  }

  if (status === 402) {
    const message =
      typeof error?.message === 'string'
        ? error.message
        : 'Subscription required.'
    printError(message)
    const subscribeUrl =
      error?.payload && typeof error.payload === 'object'
        ? error.payload.subscribeUrl
        : null
    if (typeof subscribeUrl === 'string' && subscribeUrl.trim()) {
      printError(`Subscribe: ${subscribeUrl}`)
    }
    process.exit(1)
    return
  }

  if (status === 429) {
    const message =
      typeof error?.message === 'string'
        ? error.message
        : 'Rate limit exceeded.'
    printError(message)

    const retryAfterSeconds =
      error?.payload && typeof error.payload === 'object'
        ? Number(error.payload.retryAfterSeconds)
        : Number.NaN

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      printError(`Retry after: ${Math.ceil(retryAfterSeconds)}s`)
    }

    process.exit(1)
    return
  }

  if (status === 404) {
    printError('CLI endpoint not found on server.')
    printError(`Expected server URL: ${API_BASE_URL}`)
    process.exit(1)
    return
  }

  printError(typeof error?.message === 'string' ? error.message : String(error))
  process.exit(1)
})
