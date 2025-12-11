[![npm version](https://img.shields.io/npm/v/@itrocks/fastify?logo=npm)](https://www.npmjs.org/package/@itrocks/fastify)
[![npm downloads](https://img.shields.io/npm/dm/@itrocks/fastify)](https://www.npmjs.org/package/@itrocks/fastify)
[![GitHub](https://img.shields.io/github/last-commit/itrocks-ts/fastify?color=2dba4e&label=commit&logo=github)](https://github.com/itrocks-ts/fastify)
[![issues](https://img.shields.io/github/issues/itrocks-ts/fastify)](https://github.com/itrocks-ts/fastify/issues)
[![discord](https://img.shields.io/discord/1314141024020467782?color=7289da&label=discord&logo=discord&logoColor=white)](https://25.re/ditr)

# fastify

Converts Fastify requests to it.rocks agnostic requests and responses back to Fastify.

*This documentation was written by an artificial intelligence and may contain errors or approximations.
It has not yet been fully reviewed by a human. If anything seems unclear or incomplete,
please feel free to contact the author of this package.*

## Installation

```bash
npm i @itrocks/fastify
```

`@itrocks/fastify` declares `fastify` and the required `@fastify/*` plugins as
dependencies, so you usually only need to install this package in your
application. If you want to customise how Fastify itself is created, you can of
course install and configure `fastify` directly in addition.

## Usage

This package exposes two levels of API:

- low‑level helpers (`fastifyRequest` and `fastifyResponse`) to convert between
  Fastify objects and the `@itrocks/request-response` abstractions;
- a high‑level `FastifyServer` class that starts and configures a Fastify HTTP
  server for you based on an `FastifyConfig` object.

In most applications you will only interact with `FastifyServer`: you pass it
your it.rocks‑style request handler and some configuration (ports, paths,
assets), then call `run()` to start the server.

### Minimal example

```ts
import { FileStore } from '@itrocks/fastify-file-session-store'
import { FastifyServer, type FastifyConfig } from '@itrocks/fastify'
import type { Request, Response } from '@itrocks/request-response'

async function execute(request: Request): Promise<Response> {
  // Here you plug in your it.rocks application or any component that
  // understands @itrocks/request-response Request/Response objects.
  // This is a very small example that always returns JSON.
  return new Response(200, { 'content-type': 'application/json' }, { ok: true })
}

const config: FastifyConfig = {
  assetPath: './public',
  execute,
  favicon: './public/favicon.png',
  frontScripts: [],
  host: '0.0.0.0',
  port: 3000,
  scriptCalls: [],
  secret: 'change-me-in-production-with-at-least-32-characters',
  store: new FileStore('./sessions'),
}

const server = new FastifyServer(config)

server.run()
  .then(() => console.log('Server listening on http://localhost:3000'))
  .catch((error) => {
    console.error('Cannot start server', error)
    process.exit(1)
  })
```

### Complete and realistic example

The following example shows a more advanced configuration that:

- serves static assets from a `dist` directory, including automatic discovery
  of front‑end JavaScript dependencies;
- forwards all non‑asset HTTP calls to an it.rocks application through a
  single `execute` function;
- uses `@itrocks/fastify-file-session-store` to persist sessions on disk;
- reads configuration from environment variables.

```ts
import { FastifyServer, type FastifyConfig } from '@itrocks/fastify'
import { FileStore } from '@itrocks/fastify-file-session-store'
import { Request, Response } from '@itrocks/request-response'
import { join, normalize } from 'node:path'

// Example application entry point: transform a Request into a Response
async function execute(request: Request): Promise<Response> {
  if (request.path === '/api/health') {
    return new Response(200, { 'content-type': 'application/json' }, { status: 'ok' })
  }

  // Fallback behaviour: return 404 for unknown routes
  return new Response(404, { 'content-type': 'application/json' }, { error: 'Not found' })
}

const assetPath = normalize(join(__dirname, '../dist'))

const config: FastifyConfig = {
  assetPath,
  execute,
  favicon: normalize(join(assetPath, 'favicon.png')),
  frontScripts: [
    // relative paths (from assetPath) of entry front‑end scripts
    '/front/main.js',
  ],
  host: process.env.HOST ?? '0.0.0.0',
  manifest: '/manifest.json',
  port: Number(process.env.PORT ?? 3000),
  scriptCalls: [
    // function names that dynamically import additional scripts, for example:
    'loadScript',
  ],
  secret: process.env.SESSION_SECRET
    ?? 'replace-this-secret-in-production-with-a-long-random-string',
  store: new FileStore(normalize(join(__dirname, '../data/sessions'))),
}

const server = new FastifyServer(config)

server.run().catch((error) => {
  console.error(error, 'Cannot start Fastify server')
  process.exit(1)
})
```

In this configuration, `FastifyServer` takes care of:

- creating and configuring the underlying Fastify instance;
- wiring `@fastify/cookie`, `@fastify/formbody`, `@fastify/multipart` and
  `@fastify/session` with reasonable defaults;
- routing all HTTP methods (`GET`, `POST`, `PUT`, `DELETE`) through a single
  handler that either serves static assets or delegates to your `execute`
  function.

If you only need the conversion helpers, you can also call
`fastifyRequest()` and `fastifyResponse()` directly in your own Fastify
routes.

```ts
import { fastifyRequest, fastifyResponse } from '@itrocks/fastify'

app.all('/*', async (fastifyReq, fastifyReply) => {
  const request = await fastifyRequest(fastifyReq)
  const response = await myItRocksHandler(request)
  return fastifyResponse(fastifyReply, response)
})
```

## API

### `type FastifyConfig`

Configuration object used to build a `FastifyServer` instance.

```ts
type FastifyConfig = {
  assetPath: string
  execute: (request: Request) => Promise<Response>
  favicon: string
  frontScripts: string[]
  host: string
  manifest?: string
  port: number
  scriptCalls: string[]
  secret: string
  store: SessionStore
}
```

#### Properties

- `assetPath` – absolute or normalised path to the directory that contains
  your static assets (HTML, CSS, JS, images…). All asset responses are resolved
  relative to this path.
- `execute` – asynchronous function that receives an
  `@itrocks/request-response` `Request` and must return a `Response`. This is
  where you plug in your it.rocks application logic.
- `favicon` – path (relative to `assetPath` or absolute) of the file served
  when the client requests `/favicon.png`.
- `frontScripts` – list of script paths (relative to `assetPath`) that are
  considered as entry front‑end bundles. When such a script is requested, the
  server scans it for `import` statements and configured `scriptCalls` to
  discover and serve additional JavaScript files.
- `host` – host/IP that Fastify should bind to, for example `'0.0.0.0'`.
- `manifest` – optional path to a web app manifest JSON file. When a request
  targets `/manifest.json`, this file is served instead.
- `port` – TCP port on which Fastify will listen.
- `scriptCalls` – array of function names used in your front‑end code to
  dynamically load additional scripts (for example `loadScript('/front/other.js')`).
  The server scans your entry scripts for occurrences of these calls to
  determine which additional assets must be exposed.
- `secret` – secret string used to sign and encrypt session cookies for
  `@fastify/session`. Must be long and random in production.
- `store` – implementation of `SessionStore` used by `@fastify/session` to
  persist session data (for example a `FileStore` from
  `@itrocks/fastify-file-session-store`).

---

### `function fastifyRequest(request: FastifyRequest): Promise<Request>`

Converts a `FastifyRequest` instance into an `@itrocks/request-response`
`Request`.

#### Parameters

- `request` – Fastify request to convert. It may contain query parameters,
  route parameters, a JSON or form body and, in the case of multipart
  requests, uploaded files.

#### Behaviour

- builds a new `Request` with the HTTP method, protocol, host, port, path,
  headers, URL parameters and body data extracted from the Fastify request;
- when the request is multipart, form fields and uploaded files are converted
  into `RequestFile` objects from `@itrocks/request-response`.

#### Return value

- `Promise<Request>` – the corresponding it.rocks request object.

---

### `function fastifyResponse(fastifyResponse: FastifyReply, response: Response): FastifyReply`

Writes an `@itrocks/request-response` `Response` to a `FastifyReply` and
returns it.

#### Parameters

- `fastifyResponse` – the Fastify reply object that will be sent back to the
  client.
- `response` – the it.rocks response to serialise.

#### Behaviour

- copies all headers from the `Response` onto the reply;
- sets the HTTP status code;
- sends the response body as the reply payload.

#### Return value

- `FastifyReply` – the same reply instance, for chaining in Fastify routes.

---

### `class FastifyServer`

High‑level helper that configures and starts a Fastify HTTP server from a
`FastifyConfig` object.

```ts
class FastifyServer {
  constructor(config: FastifyConfig)

  addImportsToFrontScripts(fromScript: string): Promise<void>

  errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void

  httpCall(originRequest: FastifyRequest, finalResponse: FastifyReply): Promise<never>

  run(): Promise<void>
}
```

#### `new FastifyServer(config: FastifyConfig)`

Creates a server instance using the given configuration. The instance is not
started until you call `run()`.

#### `addImportsToFrontScripts(fromScript: string): Promise<void>`

Internal helper that scans the JavaScript file at `fromScript` for `import`
statements and configured `scriptCalls`, then ensures that all discovered
scripts are present in `config.frontScripts`.

You rarely need to call this method directly; it is mainly provided so that
advanced integrations can reuse the asset‑scanning logic.

#### `errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void`

Default Fastify error handler used by the server.

- For validation errors (when `error.validation` is set), it returns a
  `400 Bad Request` response with a generic JSON body.
- For all other errors, it returns a `500 Internal Server Error` response with
  a generic JSON body.

You can override this method on a `FastifyServer` instance if you want custom
error responses.

#### `httpCall(originRequest: FastifyRequest, finalResponse: FastifyReply): Promise<never>`

Main request handler used for all HTTP methods on the `/*` route.

- serves static assets (including JavaScript and TypeScript files) based on
  the request path and `FastifyConfig` options;
- when no asset should be served, converts the Fastify request to an it.rocks
  `Request`, calls `config.execute` and sends the resulting `Response` back to
  the client.

You generally do not call this method directly; it is registered internally by
`run()`.

#### `run(): Promise<void>`

Creates the underlying Fastify instance, registers the required plugins,
configures the routes and starts listening on the configured `host` and
`port`.

The returned promise resolves once the server is listening, or rejects if the
startup fails.

## Typical use cases

- **Expose an it.rocks backend over HTTP using Fastify**: you already have an
  application that speaks `@itrocks/request-response` and you want to serve it
  through a production‑ready Fastify server.
- **Serve a single‑page front‑end and an API from the same server**: configure
  `assetPath`, `frontScripts` and `manifest` so that static assets are served
  directly, while `/api/*` routes are handled by your `execute` function.
- **Quickly bootstrap a new it.rocks project**: start with `FastifyServer` to
  avoid boilerplate Fastify configuration and focus on your domain logic.
- **Custom Fastify integrations**: use `fastifyRequest` and `fastifyResponse`
  directly when you need full control over Fastify routes but still want to
  reuse existing it.rocks components.
