# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2]

### Added

- Added global keyword tag management with `asosuite tags list`, `create`, `edit`, and `delete`.
- Added keyword note editing with `asosuite tracked-keywords note set` and `clear`.
- Added keyword tag assignment with `asosuite tracked-keywords tags set`.
- Added tag filtering to `tracked-keywords list` with `--tag` and `--tags`.
- Added `notes` and `tags` columns to tracked keyword CLI table output.
- Added `notes` and `tags` as tracked keyword sort fields.

### Changed

- `tracked-keywords list --sort tags` sorts by tag label/name, with tagged rows before untagged rows.
- Updated README and SKILL.md command documentation for notes and tags.
