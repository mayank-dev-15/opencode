import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put"])

type Operation = {
  operationId?: string
}

type OpenApi = {
  paths?: Record<string, Record<string, Operation>>
}

export default Runtime.handler(
  Commands.commands.api,
  Effect.fn("cli.api")(function* (input) {
    const daemon = yield* Daemon.Service
    const transport = yield* daemon.transport()
    const params = Option.getOrElse(input.param, () => ({}))
    const request = yield* resolveRequest(transport, input.request, params)
    const headers = new Headers(transport.headers)
    for (const header of input.header) {
      const index = header.indexOf(":")
      if (index < 1) return yield* Effect.fail(new Error(`Invalid header, expected name:value: ${header}`))
      headers.set(header.slice(0, index).trim(), header.slice(index + 1).trim())
    }
    const body = Option.getOrUndefined(input.data)
    if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")

    const response = yield* Effect.tryPromise(() =>
      fetch(new URL(request.path, transport.url), {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(30000),
      }),
    )
    if (!response.ok) return yield* Effect.fail(new Error(`API request failed: HTTP ${response.status}`))
    const output = yield* Effect.promise(() => response.text())
    if (output) process.stdout.write(output + (output.endsWith(EOL) ? "" : EOL))
  }),
)

export function resolveOperation(spec: OpenApi, operationID: string, params: Record<string, string>) {
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!methods.has(method) || operation.operationId !== operationID) continue
      return Effect.succeed({ method: method.toUpperCase(), path: interpolate(path, params) })
    }
  }
  return Effect.fail(new Error(`Operation not found: ${operationID}`))
}

export function rawRequest(input: readonly string[]) {
  if (input.length !== 2 || !methods.has(input[0].toLowerCase()) || !input[1].startsWith("/")) return
  return { method: input[0].toUpperCase(), path: input[1] }
}

function resolveRequest(
  transport: { url: string; headers: RequestInit["headers"] },
  input: readonly string[],
  params: Record<string, string>,
) {
  const raw = rawRequest(input)
  if (raw) return Effect.succeed(raw)
  if (input.length !== 1) return Effect.fail(new Error("Expected an operation name or an HTTP method and path"))
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      fetch(new URL("/openapi.json", transport.url), { headers: transport.headers }),
    )
    if (!response.ok) return yield* Effect.fail(new Error(`Failed to load OpenAPI document: HTTP ${response.status}`))
    const spec = yield* Effect.tryPromise(() => response.json() as Promise<OpenApi>)
    return yield* resolveOperation(spec, input[0], params)
  })
}

function interpolate(path: string, params: Record<string, string>) {
  const used = new Set<string>()
  const pathname = path.replaceAll(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`Missing path parameter: ${name}`)
    used.add(name)
    return encodeURIComponent(value)
  })
  const query = new URLSearchParams(Object.entries(params).filter(([name]) => !used.has(name))).toString()
  return query ? `${pathname}?${query}` : pathname
}
