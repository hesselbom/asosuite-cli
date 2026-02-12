# ASO Suite CLI

ASO Suite CLI is a small command-line client for [ASO Suite](https://www.asosuite.com/) subscribers.

## Commands

- `asosuite login`
- `asosuite logout`
- `asosuite subscription`
- `asosuite keywords [--region <REGION>] [--platform <PLATFORM>] [--app <APP_ID_OR_URL>] <keyword...>`
  - Defaults: `region=US`, `platform=iphone`.
  - Supported platforms: `iphone`, `ipad`, `mac`, `appletv`, `watch`, `vision`.

## Install (local)

Clone the repo, then from the root folder:

```bash
# Install dependencies
npm install

# Link the CLI globally
npm link

# Check that it's working
asosuite help
```

## Authentication flow

`asosuite login` starts a device-style sign-in flow:

1. CLI asks the server for a short-lived device code.
2. CLI opens your browser at `https://www.asosuite.com/cli/auth?code=...`.
3. You sign in and approve the CLI request.
4. CLI polls the server and receives a long-lived CLI access token.

The token is stored at `~/.asosuite/config.json`.

## Notes

- Keyword metrics are currently limited to 50 keywords per request on the server.
