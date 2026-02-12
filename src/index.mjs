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
const DEFAULT_POLL_INTERVAL_SECONDS = 3
const DEFAULT_REGION = 'US'
const DEFAULT_PLATFORM = 'iphone'
const APP_ID_MIN_LENGTH = 6
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
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(
    CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  )
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
  print('  asosuite subscription')
  print(
    `  asosuite keywords [--region <REGION>] [--platform <PLATFORM>] [--app <APP_ID_OR_URL>] <keyword...>`,
  )
  print('  asosuite help')
  print('')
  print(`Defaults: region=${DEFAULT_REGION}, platform=${DEFAULT_PLATFORM}`)
  print('Supported platforms: iphone, ipad, mac, appletv, watch, vision')
  print('')
  print('Examples:')
  print('  asosuite keywords keyword1 keyword2')
  print('  asosuite keywords "run tracker"')
  print('  asosuite keywords --region SE "run tracker" "calorie counter"')
  print('  asosuite keywords --app 1606429298 "run tracker"')
  print(
    '  asosuite keywords --platform ipad --app 1606429298 keyword1 keyword2',
  )
  print(
    '  asosuite keywords --app "https://apps.apple.com/us/app/watchletic-run-tracker/id1606429298" --platform ipad "run tracker"',
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

async function runSubscriptionStatus(rest) {
  const config = await loadConfig()

  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`)
  }

  const accessToken = getAccessToken(config)

  if (!accessToken) {
    throw new Error('Not authenticated. Run `asosuite login` first.')
  }

  const subscription = await apiRequest({
    pathName: '/api/cli/subscription',
    accessToken,
  })

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

  const widths = headers.map((header) => header.length)

  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      widths[index] = Math.max(widths[index], row[index].length)
    }
  }

  const formatRow = (row) =>
    row
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
      )
      .join('  ')

  print(formatRow(headers))
  print(widths.map((width) => '-'.repeat(width)).join('  '))

  for (const row of rows) {
    print(formatRow(row))
  }
}

async function runKeywordMetrics(rest) {
  const config = await loadConfig()
  const regionValue = takeOption(rest, '--region')
  const platformValue = takeOption(rest, '--platform')
  const appOptionValue = takeOption(rest, '--app')
  let appId = null

  if (appOptionValue) {
    const parsedApp = parseAppInput(appOptionValue)
    if (!parsedApp) {
      throw new Error(
        'Invalid --app value. Use an App Store URL, id-prefixed value, or numeric id.',
      )
    }
    appId = parsedApp.appId
  } else {
    const maybeAppToken = rest[0]
    const parsedApp = parseAppInput(maybeAppToken)
    if (parsedApp) {
      rest.shift()
      appId = parsedApp.appId
    }
  }

  const keywords = rest
    .map((value) => String(value || '').trim())
    .map((value) => value.replace(/^["']+|["']+$/g, ''))
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value.length > 0)

  if (keywords.length === 0) {
    throw new Error('Provide at least one keyword')
  }

  if (keywords.length > MAX_KEYWORDS) {
    throw new Error(`At most ${MAX_KEYWORDS} keywords are allowed per request`)
  }

  const accessToken = getAccessToken(config)

  if (!accessToken) {
    throw new Error('Not authenticated. Run `asosuite login` first.')
  }

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

  if (command === 'keywords') {
    await runKeywordMetrics(rest)
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
