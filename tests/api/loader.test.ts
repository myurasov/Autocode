/*
 * Unloaded folders (spec, OpenCode Plugin: Unloaded folders): when the server
 * has work for an offline host on its own machine whose OpenCode is the
 * background service, it asks that service to load the folder again (GET
 * /api/location, with the service's password), at most once a minute; hosts on
 * other machines, or in other OpenCode processes, are left alone.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  ack,
  call,
  hello,
  instructions,
  registered,
  type TestServer,
  testServer,
} from "../helpers/server.ts"

let t: TestServer
let service: ReturnType<typeof Bun.serve>
let asked: { path: string; directory: string | null; auth: string | null }[]

beforeEach(async () => {
  asked = []
  service = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url)
      // the published client's form of a location: location[directory]=
      asked.push({
        path: url.pathname,
        directory: url.searchParams.get("location[directory]"),
        auth: req.headers.get("authorization"),
      })
      if (url.searchParams.get("location[directory]") === "/broken")
        return new Response("no", { status: 500 })
      if (url.pathname === "/api/info")
        return Response.json({ version: "2.2.0", pid: 77 })
      return Response.json({ directory: url.searchParams.get("directory") })
    },
  })
  t = await testServer({
    machine: "m",
    findService: async () => ({
      url: `http://127.0.0.1:${service.port}`,
      authorization: "Basic b3BlbmNvZGU6cHc=",
    }),
  })
})
afterEach(async () => {
  await t.stop()
  service.stop(true)
})

// An agent with a due wake on a host that then goes offline.
async function waitingOn(host: string, kind = "service", directory = "/work") {
  await hello(t, host, { process: { pid: 77, kind }, directory })
  const token = await registered(t, host, `ses_${host}`, `${host}:agent`)
  for (const i of await instructions(t, host)) await ack(t, host, i.id)
  await call(t.url, token, "PUT", "/v1/me/wakes/w", {
    text: "Go.",
    trigger: "every 1m",
  })
  t.clock.advance(60_000)
  t.server.maintenance() // the host has not polled: offline
}

test("an offline host of this machine's background service gets its folder loaded, once a minute at most", async () => {
  await waitingOn("m:1")
  t.server.tick()
  await Bun.sleep(200)
  expect(asked).toEqual([
    { path: "/api/info", directory: null, auth: "Basic b3BlbmNvZGU6cHc=" },
    {
      path: "/api/location",
      directory: "/work",
      auth: "Basic b3BlbmNvZGU6cHc=",
    },
  ])
  t.clock.advance(30_000)
  t.server.tick()
  await Bun.sleep(200)
  expect(asked.length).toBe(2)
  t.clock.advance(31_000)
  t.server.tick()
  await Bun.sleep(200)
  expect(asked.length).toBe(4)
  const history = await call(
    t.url,
    t.admin,
    "GET",
    "/v1/history?kind=host.load",
  )
  expect(history.body.history[0]).toMatchObject({
    host: "m:1",
    data: { directory: "/work", pid: 77 },
  })
})

test("hosts on other machines, or not in the background service, are left alone", async () => {
  await waitingOn("z:1")
  await waitingOn("m:2", "serve")
  t.server.tick()
  await Bun.sleep(200)
  expect(asked).toEqual([])
})

test("an online host, or one with nothing waiting, is not loaded", async () => {
  await hello(t, "m:3", { process: { pid: 77, kind: "service" } })
  await registered(t, "m:3", "ses_m3", "m3:agent")
  t.server.tick()
  t.clock.advance(60_000)
  t.server.maintenance()
  t.server.tick()
  await Bun.sleep(200)
  expect(asked).toEqual([])
})

test("a failing load backs off, and its failure is recorded once per streak", async () => {
  await waitingOn("m:9", "service", "/broken")
  const loads = () => asked.filter((x) => x.path === "/api/location").length
  for (let i = 0; i < 6; i++) {
    t.server.tick()
    await Bun.sleep(150)
    t.clock.advance(60_000)
  }
  // tried at 0, 2 and (after 4 more minutes) 6 minutes: not every minute
  expect(loads()).toBe(2)
  const failed = await call(
    t.url,
    t.admin,
    "GET",
    "/v1/history?kind=host.load_failed",
  )
  expect(failed.body.history.length).toBe(1)
})
