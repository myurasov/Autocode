/*
 * The web UI in a real browser against a real server: sign-in, the Hosts,
 * Agents, Inbox, Messages, Locks and Wakes pages (Pause and Resume, an answer,
 * a message sent, a hold released, a wake set, fired and cancelled), History,
 * a settings change, refused
 * tokens, and the layout (the pages fit their frame, the frame's padding, the
 * header's items are centered, the main text is 15 px, a page's first item has
 * no top margin, buttons are as tall as text fields, headings are in Title
 * Case, "Updated" in the footer, an action's result in the toolbar, the forms
 * full width and collapsed, the table cells' padding).
 */
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  request,
  test,
} from "@playwright/test"

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const base = process.env.BASE_URL ?? "http://127.0.0.1:4848"
const admin = env("ADMIN_TOKEN")
const consumer = env("CONSUMER_TOKEN")
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
let sessionToken = ""
let longToken = ""

// An agent with values as long as real ones, for the layout checks.
const LONG = {
  host: "layout:host:1",
  session: "ses_e7d5a9981ffeMI0at2ZTpikxTp",
  agent: "live:laptop:glm-5.3:20261028T1314",
  directory: "/Users/someone/work/projects/autocode/source/__out/live/project",
}

/*
 * The fixture, without OpenCode: a host says hello, gets a token for one of its
 * sessions, and that session registers smoke:agent; a second host does the same
 * for the long agent. Each agent sets a wake and sends the owner a message
 * (for the Wakes, Messages and Inbox pages). min_interval goes back to its
 * default, so every run starts the same way.
 */
test.beforeAll(async () => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  try {
    const hello = await api.post("/v1/hosts/smoke:host:1/hello", {
      headers: bearer(consumer),
      data: {
        instance: "i1",
        machine: "smoke",
        directory: "/work",
        process: { pid: 4242, kind: "service" },
        shell_values: true,
      },
    })
    expect(hello.ok(), await hello.text()).toBe(true)
    const issued = await api.post(
      "/v1/hosts/smoke:host:1/sessions/ses_smoke1/token",
      {
        headers: bearer(consumer),
        data: {},
      },
    )
    expect(issued.ok(), await issued.text()).toBe(true)
    sessionToken = (await issued.json()).token
    const registered = await api.post("/v1/agents", {
      headers: bearer(sessionToken),
      data: { id: "smoke:agent", description: "made by the smoke test" },
    })
    expect([200, 201], await registered.text()).toContain(registered.status())
    const longHello = await api.post(`/v1/hosts/${LONG.host}/hello`, {
      headers: bearer(consumer),
      data: {
        instance: "i2",
        machine: "laptop",
        directory: LONG.directory,
        sessions: [LONG.session],
        process: { pid: 31337, kind: "serve" },
        shell_values: false,
      },
    })
    expect(longHello.ok(), await longHello.text()).toBe(true)
    const longIssued = await api.post(
      `/v1/hosts/${LONG.host}/sessions/${LONG.session}/token`,
      { headers: bearer(consumer), data: {} },
    )
    expect(longIssued.ok(), await longIssued.text()).toBe(true)
    longToken = (await longIssued.json()).token
    const longRegistered = await api.post("/v1/agents", {
      headers: bearer(longToken),
      data: { id: LONG.agent, description: "live check of tier 0a" },
    })
    expect([200, 201], await longRegistered.text()).toContain(
      longRegistered.status(),
    )
    const wakes = [
      {
        token: sessionToken,
        name: "smoke-check",
        data: { text: "Check the smoke.", trigger: "every 30m" },
      },
      {
        token: longToken,
        name: "layout-check-of-a-long-wake-name",
        data: {
          text:
            "Look at the layout of every page of the web UI and report " +
            "what does not fit.\nThen go on.",
          trigger: 'cron "0 9 * * 1-5"',
          check: `test -f ${LONG.directory}/go-on-with-the-layout-check`,
        },
      },
    ]
    for (const w of wakes) {
      const set = await api.put(`/v1/me/wakes/${w.name}`, {
        headers: bearer(w.token),
        data: w.data,
      })
      expect(set.ok(), await set.text()).toBe(true)
    }
    const notes = [
      { token: sessionToken, subject: "Smoke" },
      {
        token: longToken,
        subject: "A long subject line from the layout check of the web UI",
      },
    ]
    for (const n of notes) {
      const sent = await api.post("/v1/messages", {
        headers: bearer(n.token),
        data: {
          to: "owner",
          subject: n.subject,
          text: "Hello from the smoke test.\nA second line.",
        },
      })
      expect(sent.status(), await sent.text()).toBe(201)
    }
    const reset = await api.patch("/v1/settings", {
      headers: bearer(admin),
      data: { server: { min_interval: null } },
    })
    expect(reset.ok(), await reset.text()).toBe(true)
    await makeLocks(api)
    await setJob(api, "smoke-report", {
      description: "Reports on the smoke test",
      trigger: "every 24h",
    })
  } finally {
    await api.dispose()
  }
})

/*
 * A job on the fixture's host (tier 0f), set through the API: a model that
 * never runs here (the fixture's host has no plugin, so a run stays starting
 * until it fails), a prompt and a trigger.
 */
async function setJob(
  api: APIRequestContext,
  name: string,
  change: Record<string, unknown> = {},
) {
  const res = await api.put(`/v1/jobs/${name}`, {
    headers: bearer(admin),
    data: {
      host: "smoke:host:1",
      model: "test/model",
      prompt: "Report on the smoke test.",
      trigger: "fire-only",
      ...change,
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
}

async function deleteJob(api: APIRequestContext, name: string) {
  await api.delete(`/v1/jobs/${name}`, { headers: bearer(admin) })
}

// An agent's acquire of a lock (queued when it is taken).
async function acquire(
  api: APIRequestContext,
  token: string,
  name: string,
  data: { ttl: string; max?: number },
) {
  const res = await api.post(`/v1/locks/${name}/acquire`, {
    headers: bearer(token),
    data,
  })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

/*
 * The fixture's locks (tier 0c): a mutex gpu-0 that smoke:agent holds and the
 * long agent waits for, and a semaphore gpu-pool of 2 places that both hold.
 * Acquiring again renews a hold or keeps a place, so this can run again.
 */
async function makeLocks(api: APIRequestContext) {
  await acquire(api, sessionToken, "gpu-0", { ttl: "1h" })
  await acquire(api, longToken, "gpu-0", { ttl: "1h" })
  await acquire(api, sessionToken, "gpu-pool", { ttl: "2h", max: 2 })
  await acquire(api, longToken, "gpu-pool", { ttl: "2h", max: 2 })
}

async function signIn(page: Page, token: string) {
  await page.goto("/")
  await page.getByLabel("Token").fill(token)
  await page.getByRole("button", { name: "Sign In", exact: true }).click()
  await expect(page.getByRole("link", { name: "Agents" })).toBeVisible()
}

// A tab's page once its data is in: its "Loading..." row, which a check could
// catch as it goes, is gone.
const LOADED: Record<string, string> = {
  Hosts: "table.hosts tr[data-host]",
  Agents: "table.agents tr[data-agent]",
  Inbox: "table.inbox tr[data-item]",
  Messages: "table.messages tr[data-message]",
  Locks: "table.locks tr[data-lock]",
  Wakes: "table.wakes tr[data-wake]",
  Jobs: "table.jobs tr[data-job]",
  Costs: "table.costs tr[data-agent]",
  History: "table.history tr[data-entry]",
  Settings: "table.settings tr[data-key]",
  Help: "article h2",
}
const TABS = Object.keys(LOADED)
// The tab itself: Help's contents link to sections with the same names.
async function openTab(page: Page, tab: string) {
  await page.getByRole("link", { name: tab, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${tab.toLowerCase()}$`))
  // the fixture's hosts go offline between their polls: show them all
  if (tab === "Hosts") {
    const offline = page.getByRole("checkbox", { name: "Offline" })
    if (!(await offline.isChecked())) await offline.check()
  }
  await expect(page.locator(`#frame ${LOADED[tab]}`).first()).toBeVisible()
}

test("admin: Agents shows smoke:agent under machine smoke, Hosts its host", async ({
  page,
}) => {
  await signIn(page, admin)
  await expect(page.locator("header h1")).toHaveText("Autocode v0.1.0-dev")
  await expect(page.locator("header .who")).toHaveText("admin")
  await expect(page.locator("nav a")).toHaveText([
    "Hosts",
    "Agents",
    "Inbox",
    "Messages",
    "Locks",
    "Wakes",
    "Jobs",
    "Costs",
    "History",
    "Settings",
    "Help",
  ])
  const machine = page.locator('table.agents tbody[data-machine="smoke"]')
  await expect(machine.locator("tr.group")).toHaveText("smoke")
  const agent = machine.locator('tr[data-agent="smoke:agent"]')
  await expect(agent.locator("td.desc")).toHaveText("made by the smoke test")
  await expect(agent.getByRole("button", { name: "Unregister" })).toBeVisible()
  // How long ago the page loaded, counting up every second, in the footer.
  const updated = page.locator("#frame footer")
  await expect(updated).toHaveText(/^Updated \d+s ago\.$/)
  await expect(updated).toHaveText(/^Updated [1-9]\d*s ago\.$/)
  await openTab(page, "Hosts")
  await expect(page.locator("#frame .toolbar .muted")).toHaveText(
    "One per OpenCode server folder that the Autocode plugin connects from.",
  )
  await expect(updated).toHaveText(/^Updated \d+s ago\.$/)
  // Hosts by machine, as on Agents; the column is Status, not Online.
  await expect(page.locator("table.hosts thead th")).toHaveText([
    "ID",
    "Folder",
    "Status",
    "Process",
    "OpenCode",
    "Plugin",
    "Last Seen",
  ])
  const hostMachine = page.locator('table.hosts tbody[data-machine="smoke"]')
  await expect(hostMachine.locator("tr.group")).toHaveText("smoke")
  const host = hostMachine.locator('tr[data-host="smoke:host:1"]')
  await expect(host.locator("td.folder")).toHaveText("/work")
  await expect(host.locator("td.process")).toHaveText("bg service (4242)")
  // Shell values are no column of their own: a host whose shells get none
  // says so in its Process cell.
  await expect(page.locator("table.hosts td.shell")).toHaveCount(0)
  const long = page.locator(`table.hosts tr[data-host="${LONG.host}"]`)
  await expect(long.locator("td.process")).toContainText(
    "opencode serve (31337)",
  )
  await expect(long.locator("td.process .no-shell")).toHaveText(
    "no shell values",
  )
  await expect(long.locator("td.process .no-shell")).toHaveAttribute(
    "title",
    /local API/,
  )
})

test("admin: Settings shows min_interval 1m and saves 2m", async ({ page }) => {
  await signIn(page, admin)
  await page.getByRole("link", { name: "Settings" }).click()
  await expect(page.locator("table.settings thead th")).toHaveText([
    "Setting",
    "Value",
    "From",
    "Scope",
    "Description",
  ])
  const row = page.locator('table.settings tr[data-key="min_interval"]')
  const value = row.locator("td.value").getByLabel("Value of min_interval")
  await expect(value).toHaveValue("1m")
  await expect(row.locator("td.from")).toHaveText("built-in default")
  await value.fill("2m")
  await row.locator("td.value").getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Saved min_interval.")).toBeVisible()
  await expect(value).toHaveValue("2m")
  await expect(row.locator("td.from")).toHaveText("set server-wide")
  await page.reload()
  await expect(value).toHaveValue("2m")
})

test("admin: Inbox, Messages and Wakes show the fixture's rows", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "Inbox")
  await expect(page.locator("table.inbox thead th")).toHaveText([
    "Time",
    "Kind",
    "Agent",
    "Sent To",
    "Item",
    "",
  ])
  const item = page
    .locator("table.inbox tr[data-item]", {
      hasText: 'Message from smoke:agent: "Smoke"',
    })
    .first()
  await expect(item.locator("td.kind")).toHaveText("Message")
  await expect(item.locator("td.agent")).toHaveText("smoke:agent")
  await expect(item.locator("td.sent-to")).toHaveText("owner")
  const body = item.locator(".body")
  await expect(body).toContainText("A second line.")
  await expect(body).toHaveCSS("white-space", "pre-wrap")
  await expect(item.getByRole("button", { name: "Close" })).toBeVisible()

  await openTab(page, "Messages")
  await expect(page.locator("table.messages thead th")).toHaveText([
    "ID",
    "Time",
    "From",
    "To",
    "Subject",
    "Text",
    "Size",
    "State",
  ])
  const message = page
    .locator("table.messages tr[data-message]")
    .filter({ has: page.locator("td.subject", { hasText: /^Smoke$/ }) })
    .first()
  // A short text is shown whole, its lines kept.
  await expect(message.locator("td.text")).toHaveText(
    /^Hello from the smoke test\.\s+A second line\.$/,
  )
  await expect(message.locator("td.text .more")).toHaveCount(0)
  await expect(message.locator("td.sender")).toHaveText("smoke:agent")
  await expect(message.locator("td.recipient")).toHaveText("owner")
  await expect(message.locator("td.state")).toHaveText("delivered")

  await openTab(page, "Wakes")
  await expect(page.locator("table.wakes thead th")).toHaveText([
    "Name",
    "Trigger",
    "Next",
    "Text",
    "Check",
    "Set By",
    "Last Set",
    "Last Fired",
    "",
  ])
  const group = page.locator('table.wakes tbody[data-agent="smoke:agent"]')
  await expect(group.locator("tr.group")).toHaveText("smoke:agent")
  const wake = group.locator('tr[data-wake="smoke-check"]')
  await expect(wake.locator("td.trigger")).toHaveText("every 30m")
  await expect(wake.locator("td.text")).toHaveText("Check the smoke.")
  await expect(wake.locator("td.by")).toHaveText("smoke:agent")
  await expect(wake.locator("td.set")).toHaveAttribute(
    "title",
    /^\d{4}-\d\d-\d\dT/,
  )
  await expect(wake.locator("td.check")).toHaveText("—")
})

test("admin: Pause and Resume an agent, then Stop All and Resume All", async ({
  page,
}) => {
  await signIn(page, admin)
  const notice = page.locator(".toolbar .notice")
  const agent = page.locator('table.agents tr[data-agent="smoke:agent"]')
  const pause = agent.getByRole("button", { name: "Pause", exact: true })
  const resume = agent.getByRole("button", { name: "Resume", exact: true })
  await pause.click()
  await expect(notice).toHaveText("Paused smoke:agent.")
  await expect(page.locator("#frame p.notice")).toHaveCount(0)
  await expect(resume).toBeVisible()
  await expect(pause).toHaveCount(0)
  await expect(agent.locator("td.status")).toHaveAttribute(
    "title",
    "Paused by the owner",
  )
  await resume.click()
  await expect(notice).toHaveText("Resumed smoke:agent.")
  await expect(pause).toBeVisible()
  await expect(agent.locator("td.status")).not.toHaveAttribute("title")

  const toolbar = page.locator(".toolbar")
  page.once("dialog", (dialog) => dialog.accept())
  await toolbar.getByRole("button", { name: "Stop All" }).click()
  await expect(notice).toHaveText(
    /^Stop All paused \d+ agents? and interrupted \d+ sessions?\.$/,
  )
  await expect(resume).toBeVisible()
  await expect(agent.locator("td.status")).toHaveAttribute(
    "title",
    "Paused by Stop All",
  )
  await toolbar.getByRole("button", { name: "Resume All" }).click()
  await expect(notice).toHaveText(/^Resumed \d+ agents?\.$/)
  await expect(pause).toBeVisible()
})

test("admin: answering an inbox item closes it; Closed shows the answer", async ({
  page,
}) => {
  const subject = `Question ${Date.now()}`
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  try {
    const sent = await api.post("/v1/messages", {
      headers: bearer(sessionToken),
      data: { to: "owner", subject, text: "May I go on?" },
    })
    expect(sent.status(), await sent.text()).toBe(201)
  } finally {
    await api.dispose()
  }
  await signIn(page, admin)
  await openTab(page, "Inbox")
  const item = page.locator("table.inbox tr[data-item]", { hasText: subject })
  await expect(item.locator(".body")).toHaveText("May I go on?")
  await item.getByRole("textbox", { name: "Answer" }).fill("Yes, go on.")
  await item.getByRole("button", { name: "Answer", exact: true }).click()
  await expect(page.locator(".toolbar .notice")).toHaveText(
    "Sent the answer to smoke:agent.",
  )
  await expect(item).toHaveCount(0)
  await page.getByLabel("Closed", { exact: true }).check()
  await expect(item.locator(".answer")).toHaveText("Answer: Yes, go on.")
  await expect(item).toHaveClass(/\bclosed\b/)
  await expect(item.locator("button")).toHaveCount(0)
  // The answer went to the agent as a message from the owner.
  await openTab(page, "Messages")
  const reply = page.locator("table.messages tr[data-message]").first()
  await expect(reply.locator("td.sender")).toHaveText("owner")
  await expect(reply.locator("td.recipient")).toHaveText("smoke:agent")
})

test("admin: sends a message from the Messages page", async ({ page }) => {
  await signIn(page, admin)
  await openTab(page, "Messages")
  const form = page.locator("details.panel")
  await form.locator("summary", { hasText: "Send a Message" }).click()
  await page.getByLabel("To", { exact: true }).fill("smoke:*")
  await page.getByLabel("Text", { exact: true }).fill("Hello from the owner.")
  await expect(form).not.toContainText("Sent as the owner.")
  const sendButton = form.getByRole("button", { name: "Send", exact: true })
  await sendButton.click()
  const result = form.locator(".notice")
  await expect(result).toHaveText("Sent to smoke:agent.")
  // The result sits beside the Send button, on its line (the owner,
  // 2026-11-02).
  const b = (await sendButton.boundingBox())!
  const r = (await result.boundingBox())!
  expect(r.x - (b.x + b.width)).toBeGreaterThan(0)
  expect(r.x - (b.x + b.width)).toBeLessThanOrEqual(16)
  expect(
    Math.abs(r.y + r.height / 2 - (b.y + b.height / 2)),
  ).toBeLessThanOrEqual(2)
  const first = page.locator("table.messages tr[data-message]").first()
  await expect(first.locator("td.recipient")).toHaveText("smoke:agent")
  await expect(first.locator("td.state")).toHaveText(/^(queued|delivered)$/)
  await page.getByLabel("To", { exact: true }).fill("nobody:here")
  await page.getByLabel("Text", { exact: true }).fill("Anyone?")
  await form.getByRole("button", { name: "Send", exact: true }).click()
  await expect(form.locator(".errmsg")).toHaveText(
    "no agent nobody:here is registered",
  )
})

// Sends the owner a message as smoke:agent.
async function messageOwner(subject: string, text: string) {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  try {
    const sent = await api.post("/v1/messages", {
      headers: bearer(sessionToken),
      data: { to: "owner", subject, text },
    })
    expect(sent.status(), await sent.text()).toBe(201)
  } finally {
    await api.dispose()
  }
}

// What a long text shows folded: its first 200 characters and an ellipsis.
const folded = (text: string) => `${text.slice(0, 200).trimEnd()}…`

// A click in a cell's top right corner: its padding, away from its text.
async function clickCorner(cell: Locator) {
  const box = (await cell.boundingBox())!
  await cell.click({ position: { x: box.width - 3, y: 3 } })
}

/*
 * A long message text shows its first 200 characters and "…"; a click
 * anywhere in its cell (or Enter) shows it whole, its lines kept; the next
 * click folds it (the owner, 2026-11-03). The row itself opens nothing, and
 * the owner's read leaves the message's state.
 */
test("admin: a long message text is truncated to 200 characters; a click anywhere in its cell expands it", async ({
  page,
}) => {
  const subject = `Long ${Date.now()}`
  const long =
    "First line of a long report from the smoke test, long enough to be " +
    "cut at two hundred characters, which takes a while to write out in " +
    "full, so it goes on for a little longer than that.\n" +
    "Second line, shown only when opened."
  expect(long.length).toBeGreaterThan(200)
  await messageOwner(subject, long)
  await signIn(page, admin)
  await openTab(page, "Messages")
  const row = page
    .locator("table.messages tr[data-message]")
    .filter({ has: page.locator("td.subject", { hasText: subject }) })
  const cell = row.locator("td.text")
  const more = cell.locator(".more")
  await expect(more).toHaveText(folded(long))
  await expect(cell).toHaveCSS("cursor", "pointer")
  await expect(more).toHaveAttribute("aria-expanded", "false")
  const state = await row.locator("td.state").textContent()
  await clickCorner(cell)
  await expect(more).toHaveAttribute("aria-expanded", "true")
  await expect(more).toHaveCSS("white-space", "pre-wrap")
  await expect.poll(() => more.evaluate((e) => e.textContent)).toBe(long)
  expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
  // A click on the text itself folds it once.
  await more.click()
  await expect(more).toHaveText(folded(long))
  await more.press("Enter")
  await expect.poll(() => more.evaluate((e) => e.textContent)).toBe(long)
  await expect(row.locator("td.state")).toHaveText(state!)
  await row.locator("td.subject").click()
  await expect(page.locator("table.messages tr.detail")).toHaveCount(0)
  await expect(row).not.toHaveAttribute("tabindex")
})

// The widths of ten narrow and ten wide letters, and of "…" and "i", in an
// element's own font: equal pairs in a fixed-width font.
function widths(element: Locator) {
  return element.evaluate((e) => {
    const width = (text: string) => {
      const probe = document.createElement("span")
      probe.style.display = "inline-block"
      probe.style.whiteSpace = "pre"
      probe.textContent = text
      e.append(probe)
      const w = probe.getBoundingClientRect().width
      probe.remove()
      return w
    }
    return {
      narrow: width("iiiiiiiiii"),
      wide: width("MMMMMMMMMM"),
      ellipsis: width("…"),
      letter: width("i"),
    }
  })
}

/*
 * A long wake text and a long check show their first 200 characters and "…";
 * a click anywhere in the cell (or Enter) shows the whole, its lines kept, and
 * it stays so across the 10 s refresh; the next folds it. The check is in a
 * fixed-width font, folded and open, its "…" too (the owner, 2026-11-03).
 */
test("admin: a long wake text and check are truncated to 200 characters; a click anywhere in the cell expands them; the check is fixed-width", async ({
  page,
}) => {
  const long =
    "Look at every page of the web UI at 1024 and 1280 pixels and list " +
    "what does not fit its frame, which page it is on, at which width, " +
    "and what the owner would want it to look like.\n" +
    "Then fix the worst one first."
  const check =
    'test -n "$(find /home/someone/work/projects/team-tools/autocode/' +
    "source/__out/live/project -name '*.png' -newer " +
    "/home/someone/work/projects/team-tools/autocode/source/__out/live/" +
    'project/.last-look -print -quit)"'
  expect(long.length).toBeGreaterThan(200)
  expect(check.length).toBeGreaterThan(200)
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  try {
    const set = await api.put("/v1/me/wakes/long-text", {
      headers: bearer(sessionToken),
      data: { text: long, check, trigger: "fire-only" },
    })
    expect(set.ok(), await set.text()).toBe(true)
    await signIn(page, admin)
    await openTab(page, "Wakes")
    const wake = page.locator(
      'table.wakes tbody[data-agent="smoke:agent"] tr[data-wake="long-text"]',
    )
    const text = wake.locator("td.text")
    const more = text.locator(".more")
    await expect(more).toHaveText(folded(long))
    await expect(text).toHaveCSS("cursor", "pointer")
    await clickCorner(text)
    await expect(more).toHaveAttribute("aria-expanded", "true")
    await expect(more).toHaveCSS("white-space", "pre-wrap")
    await expect.poll(() => more.evaluate((e) => e.textContent)).toBe(long)

    const cell = wake.locator("td.check")
    const code = cell.locator("code.more")
    await expect
      .poll(() => code.evaluate((e) => e.textContent))
      .toBe(folded(check))
    await expect(cell).toHaveCSS("cursor", "pointer")
    for (const state of ["folded", "open"]) {
      if (state === "open") {
        await clickCorner(cell)
        await expect(code).toHaveAttribute("aria-expanded", "true")
      }
      const w = await widths(code)
      expect(w.narrow, state).toBeCloseTo(w.wide, 0)
      expect(w.ellipsis, state).toBeCloseTo(w.letter, 0)
    }
    await expect.poll(() => code.evaluate((e) => e.textContent)).toBe(check)
    expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
    // Still whole after the page's next refresh.
    await page.waitForTimeout(10_500)
    await expect(page.locator("#frame footer")).toHaveText(
      /^Updated [0-9]s ago\.$/,
    )
    expect(await more.evaluate((e) => e.textContent)).toBe(long)
    expect(await code.evaluate((e) => e.textContent)).toBe(check)
    await more.press("Enter")
    await expect(more).toHaveText(folded(long))
    await code.click()
    await expect
      .poll(() => code.evaluate((e) => e.textContent))
      .toBe(folded(check))
    // A short text has nothing to open.
    const short = page.locator(
      'table.wakes tr[data-wake="smoke-check"] td.text',
    )
    await expect(short.locator(".more")).toHaveCount(0)
    await expect(short).not.toHaveCSS("cursor", "pointer")
  } finally {
    await api.delete("/v1/me/wakes/long-text", {
      headers: bearer(sessionToken),
    })
    await api.dispose()
  }
})

// The Wakes Trigger column wraps like the others (the owner, 2026-11-03).
test("layout: the Wakes Trigger column wraps", async ({ page }) => {
  await signIn(page, admin)
  await openTab(page, "Wakes")
  const triggers = page.locator("table.wakes td.trigger")
  await expect(triggers.first()).toBeVisible()
  const spaces = await triggers.evaluateAll((all) => [
    ...new Set(all.map((td) => getComputedStyle(td).whiteSpace)),
  ])
  expect(spaces).toEqual(["normal"])
})

/*
 * An agent ID shown outside the Agents page links to it, which highlights
 * the agent's row and scrolls it into view; the browser's back returns (the
 * owner, 2026-11-03).
 */
test("link: an agent ID on Wakes, Messages and Inbox opens Agents with its row highlighted and in view; back returns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 500 })
  await signIn(page, admin)
  const sources: [string, string][] = [
    ["Wakes", 'table.wakes tbody[data-agent="smoke:agent"] tr.group a.id-link'],
    ["Messages", "table.messages td.sender a.id-link"],
    ["Inbox", "table.inbox td.agent a.id-link"],
  ]
  for (const [tab, selector] of sources) {
    await openTab(page, tab)
    const link = page.locator(selector, { hasText: "smoke:agent" }).first()
    await expect(link, tab).toHaveCSS("text-decoration-line", "none")
    await link.hover()
    await expect(link, tab).toHaveCSS("text-decoration-line", "underline")
    await link.click()
    await expect(page, tab).toHaveURL(/\/agents\?agent=smoke(:|%3A)agent$/)
    const row = page.locator('table.agents tr[data-agent="smoke:agent"]')
    await expect(row, tab).toHaveClass(/\bhighlight\b/)
    await expect(row, tab).toBeInViewport()
    await expect(page.locator("table.agents tr.highlight")).toHaveCount(1)
    await page.goBack()
    await expect(page, tab).toHaveURL(new RegExp(`/${tab.toLowerCase()}$`))
    await expect(page.locator(`#frame ${LOADED[tab]}`).first()).toBeVisible()
  }
})

/*
 * How a highlighted row and another row look: the row's background and
 * shadow, and its first cell's background; and what --sel and --link are now.
 */
async function looks(page: Page, table: string, attr: string) {
  return page.evaluate(
    ([table, attr]) => {
      const rows = [...document.querySelectorAll(`table.${table} tr[${attr}]`)]
      const resolved = (prop: "color" | "backgroundColor", value: string) => {
        const probe = document.createElement("span")
        probe.style[prop] = value
        document.body.append(probe)
        const out = getComputedStyle(probe)[prop]
        probe.remove()
        return out
      }
      const look = (r: Element | undefined) => {
        if (!r) return undefined
        const row = getComputedStyle(r)
        return {
          row: row.backgroundColor,
          shadow: row.boxShadow,
          cell: getComputedStyle(r.querySelector("td")!).backgroundColor,
        }
      }
      return {
        sel: resolved("backgroundColor", "var(--sel)"),
        link: resolved("color", "var(--link)"),
        highlight: look(rows.find((r) => r.classList.contains("highlight"))),
        other: look(rows.find((r) => !r.classList.contains("highlight"))),
      }
    },
    [table, attr],
  )
}

/*
 * A host ID on Agents links to the Hosts page, which highlights the host's
 * row, in both themes; the Hosts tab itself highlights nothing; back returns.
 */
test("link: a host ID on Agents opens Hosts with its row highlighted; the tab clears it", async ({
  page,
}) => {
  await signIn(page, admin)
  const link = page.locator(
    'table.agents tr[data-agent="smoke:agent"] td.host a.id-link',
  )
  await expect(link).toHaveText("smoke:host:1")
  await link.click()
  await expect(page).toHaveURL(/\/hosts\?host=smoke(:|%3A)host(:|%3A)1$/)
  const row = page.locator('table.hosts tr[data-host="smoke:host:1"]')
  await expect(row).toHaveClass(/\bhighlight\b/)
  await expect(row).toBeInViewport()
  // The highlight (the owner, 2026-11-03/04): an inset glow in the link
  // color, and no background of its own: it looks as another row does.
  for (const theme of ["one", "the other"]) {
    const look = await looks(page, "hosts", "data-host")
    expect(look.highlight, theme).toEqual({
      row: look.other?.row,
      shadow: `${look.link} 0px 0px 7px 0px inset`,
      cell: look.other?.cell,
    })
    expect(look.highlight?.row, theme).not.toBe(look.sel)
    expect(look.other?.shadow, theme).toBe("none")
    await page.getByRole("button", { name: "Light or dark" }).click()
  }
  await page.getByRole("link", { name: "Hosts", exact: true }).click()
  await expect(page).toHaveURL(/\/hosts$/)
  await expect(page.locator("table.hosts tr.highlight")).toHaveCount(0)
  await page.goBack()
  await expect(row).toHaveClass(/\bhighlight\b/)
  await page.goBack()
  await expect(page).toHaveURL(/\/agents$/)
})

// An ID that is not in the list now: a muted line says so.
test("link: an agent or host that is not there now says so", async ({
  page,
}) => {
  await signIn(page, admin)
  await page.goto("/agents?agent=nobody:here")
  await expect(page.locator("#frame p.missing")).toHaveText(
    "No agent nobody:here now.",
  )
  await expect(page.locator("table.agents tr.highlight")).toHaveCount(0)
  await page.goto("/hosts?host=gone:1")
  await expect(page.locator("#frame p.missing")).toHaveText(
    "No host gone:1 now.",
  )
})

/*
 * The error state (tier 0b3, the owner, 2026-11-04): an agent whose turn
 * failed shows error with a dot of its own, its error type and when the next
 * retry comes (full times in a tooltip), and Retry, which asks for one now
 * (its result in the toolbar); a failure that is not retried says so; a turn
 * that succeeds clears it. The page still fits 1280 px.
 */
test("error state: an agent whose turn failed shows error, its retries and Retry", async ({
  page,
}) => {
  const failing = "smoke:failing"
  const session = "ses_smoke_failing"
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const turn = (outcome: string, error?: string) =>
    api.post("/v1/hosts/smoke:host:1/events", {
      headers: bearer(consumer),
      data: {
        instance: "i1",
        events: [
          {
            type: "turn.ended",
            session,
            outcome,
            ...(error ? { error } : {}),
          },
        ],
      },
    })
  try {
    const issued = await api.post(
      `/v1/hosts/smoke:host:1/sessions/${session}/token`,
      { headers: bearer(consumer), data: {} },
    )
    expect(issued.ok(), await issued.text()).toBe(true)
    const registered = await api.post("/v1/agents", {
      headers: bearer((await issued.json()).token),
      data: { id: failing, description: "fails its turns" },
    })
    expect([200, 201], await registered.text()).toContain(registered.status())
    const failed = await turn("failed", "provider.internal")
    expect(failed.ok(), await failed.text()).toBe(true)

    await page.setViewportSize({ width: 1280, height: 800 })
    await signIn(page, admin)
    const row = page.locator(`table.agents tr[data-agent="${failing}"]`)
    const status = row.locator("td.status")
    const detail = status.locator(".error-detail")
    await expect(detail.locator(".error-type")).toHaveText("provider.internal")
    // retry_interval is 1m: the first retry comes within a minute.
    await expect(detail.locator(".retry-state")).toHaveText(
      /^retry 1 in (1m|\d+s)$/,
    )
    await expect(status).toContainText(/^\s*error/)
    await expect(detail).toHaveAttribute(
      "title",
      /^Failing since .+; last failure .+; 0 retries sent; next retry .+$/,
    )
    // A dot of its own, not offline's.
    const colors = await page.evaluate(() => {
      const dot = (kind: string) => {
        const d = document.createElement("span")
        d.className = `dot ${kind}`
        document.body.append(d)
        const color = getComputedStyle(d).backgroundColor
        d.remove()
        return color
      }
      return { err: dot("err"), off: dot("off") }
    })
    expect(colors.err).not.toBe(colors.off)
    await expect(status.locator(".dot")).toHaveCSS(
      "background-color",
      colors.err,
    )
    // Only an agent in error has Retry; the page still fits.
    const retry = row.getByRole("button", { name: "Retry", exact: true })
    await expect(
      page
        .locator("table.agents td.actions")
        .getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(1)
    expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
    await retry.click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      `Retrying ${failing}.`,
    )
    await expect(detail.locator(".retry-state")).toHaveText(
      /^(retrying now|retry 2 in (1m|\d+s))$/,
    )
    // A failure that comes back the same way is not retried.
    const auth = await turn("failed", "provider.auth")
    expect(auth.ok(), await auth.text()).toBe(true)
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(detail.locator(".error-type")).toHaveText("provider.auth")
    await expect(detail.locator(".retry-state")).toHaveText("not retried")
    // A turn that succeeds clears it.
    const ok = await turn("succeeded")
    expect(ok.ok(), await ok.text()).toBe(true)
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(detail).toHaveCount(0)
    await expect(retry).toHaveCount(0)
    await expect(status).not.toContainText("error")
  } finally {
    await api.delete(`/v1/agents/${failing}`, { headers: bearer(admin) })
    await api.dispose()
  }
})

test("admin: sets, fires and cancels a wake on the Wakes page", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "Wakes")
  const form = page.locator("details.panel")
  await form.locator("summary", { hasText: "Set a Wake" }).click()
  await page.getByLabel("Agent ID", { exact: true }).fill("smoke:agent")
  await page.getByLabel("Name", { exact: true }).fill("owner-set")
  await page.getByLabel("Trigger", { exact: true }).fill("fire-only")
  await page.getByLabel("Text", { exact: true }).fill("Set by the owner.")
  await form.getByRole("button", { name: "Set Wake" }).click()
  await expect(form.locator(".notice")).toHaveText(
    "Set smoke:agent's wake owner-set.",
  )
  const wake = page.locator(
    'table.wakes tbody[data-agent="smoke:agent"] tr[data-wake="owner-set"]',
  )
  await expect(wake.locator("td.by")).toHaveText("owner")
  await expect(wake.locator("td.next")).toHaveText("—")
  await expect(wake.locator("td.fired")).toHaveText("—")
  const notice = page.locator(".toolbar .notice")
  await wake.getByRole("button", { name: "Fire" }).click()
  await expect(notice).toHaveText("Fired smoke:agent's wake owner-set.")
  await expect(wake.locator("td.fired")).toHaveText(/^\d\d-[A-Z][a-z]{2}-/)
  page.once("dialog", (dialog) => dialog.accept())
  await wake.getByRole("button", { name: "Cancel" }).click()
  await expect(notice).toHaveText("Cancelled smoke:agent's wake owner-set.")
  await expect(wake).toHaveCount(0)
})

/*
 * IDs and id-like names (agent, host, message and session IDs, wake names,
 * setting keys, patterns, machine names) wrap as normal text, so they break
 * at their separators (after ":" and "_", which the page marks, and where the
 * browser breaks, as after "-"), never inside a word (the owner, 2026-11-03:
 * "instead of white-space: pre, use normal"), except the ID and session
 * columns, which break anywhere (the owner, 2026-11-07: a message or
 * session ID's random part has no separator). At 1024 px: every line of
 * such a cell but the last ends with a separator (in those columns, any
 * character), a long wake name breaks at its hyphens, nothing is added
 * around the ID, and the fixture's long IDs are among them.
 */
test("id cells: IDs wrap as normal text, only at separators, at 1024 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 })
  await signIn(page, admin)
  const seen: Record<string, string[]> = {}
  const lines: Record<string, number> = {}
  for (const tab of [
    "Agents",
    "Hosts",
    "Inbox",
    "Messages",
    "Locks",
    "Wakes",
    "Jobs",
    "History",
    "Settings",
  ]) {
    await openTab(page, tab)
    const cells = await page.locator("#frame .id-like").evaluateAll((all) =>
      all.map((e) => {
        const parts = [...e.querySelectorAll(".id-part")]
        const range = document.createRange()
        range.selectNodeContents(e)
        const style = getComputedStyle(e)
        return {
          raw: e.textContent ?? "",
          text: (e.textContent ?? "").trim(),
          anywhere: getComputedStyle(e).lineBreak === "anywhere",
          parts: parts.map((p) => p.textContent ?? ""),
          spaces: [
            ...new Set(parts.map((p) => getComputedStyle(p).whiteSpace)),
          ],
          // The character before each line break: walk the characters and
          // note where the next one starts lower down.
          ends: (() => {
            const out: string[] = []
            const line = Number.parseFloat(style.lineHeight)
            const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
            let last: { ch: string; top: number } | undefined
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const text = n.textContent ?? ""
              for (let i = 0; i < text.length; i++) {
                const r = document.createRange()
                r.setStart(n, i)
                r.setEnd(n, i + 1)
                const top = r.getBoundingClientRect().top
                if (last && top - last.top > line / 2) out.push(last.ch)
                last = { ch: text[i]!, top }
              }
            }
            return out
          })(),
          lines:
            range.getBoundingClientRect().height /
            Number.parseFloat(style.lineHeight),
        }
      }),
    )
    expect(cells.length, tab).toBeGreaterThan(0)
    for (const cell of cells) {
      const name = `${tab}: ${cell.text}`
      // Kept as it is, a space around the ID would show.
      expect(cell.raw, name).toBe(cell.text)
      // No ID: a dash, or an empty cell (History: an entry without one).
      if (cell.text === "—" || cell.text === "") continue
      expect(cell.parts.join(""), name).toBe(cell.text)
      expect(cell.spaces, name).toEqual(["normal"])
      // Every line but the last ends with a separator (ID and session
      // columns: anywhere).
      if (!cell.anywhere)
        expect(
          cell.ends.filter((ch) => !/[:_\-/.]/.test(ch)),
          name,
        ).toEqual([])
      lines[name] = cell.lines
    }
    seen[tab] = cells.map((cell) => cell.text)
  }
  // The long ones are among them.
  for (const id of [LONG.agent, LONG.session, LONG.host])
    expect(seen.Agents, id).toContain(id)
  expect(seen.Agents).toContain("laptop")
  expect(seen.Hosts).toContain(LONG.host)
  expect(seen.Wakes).toContain("layout-check-of-a-long-wake-name")
  // A long wake name wraps at its hyphens now (it did not with pre).
  expect(lines["Wakes: layout-check-of-a-long-wake-name"]).toBeGreaterThan(1.5)
  expect(seen.Wakes).toContain(LONG.agent)
  expect(seen.Messages).toContain(LONG.agent)
  expect(seen.Messages.some((id) => /^m_\w+$/.test(id))).toBe(true)
  expect(seen.Inbox).toContain(LONG.agent)
  expect(seen.Settings).toContain("min_interval")
  expect(seen.History).toContain("smoke:agent")
  expect(seen.History).toContain("smoke:host:1")
  expect(seen.Locks).toContain("gpu-0")
  expect(seen.Locks).toContain("smoke:agent")
  expect(seen.Locks).toContain(LONG.agent)
  expect(seen.Jobs).toContain("smoke-report")
  // The ID and session columns break anywhere; the other id-like ones not.
  const breaks = await page.evaluate(() => {
    const probe = (cls: string) => {
      const td = document.createElement("td")
      td.className = cls
      document.body.append(td)
      const v = getComputedStyle(td).lineBreak
      td.remove()
      return v
    }
    return {
      id: probe("id id-like"),
      session: probe("session id-like"),
      other: probe("from id-like"),
    }
  })
  expect(breaks).toEqual({ id: "anywhere", session: "anywhere", other: "auto" })
})

// "Updated Ns ago." sits in a footer at the bottom of the page, at the left;
// the toolbar no longer has it.
test("layout: Updated is in the footer, at the bottom left of the page", async ({
  page,
}) => {
  await signIn(page, admin)
  for (const tab of [
    "Hosts",
    "Agents",
    "Inbox",
    "Messages",
    "Locks",
    "Wakes",
    "Jobs",
    "History",
  ]) {
    await openTab(page, tab)
    const footer = page.locator("#frame footer")
    await expect(footer, tab).toHaveText(/^Updated \d+s ago\.$/)
    await expect(page.locator("#frame app-updated"), tab).toHaveCount(1)
    await expect(page.locator(".toolbar app-updated"), tab).toHaveCount(0)
    const place = await page.evaluate(() => {
      const routed = document.querySelector("#frame > router-outlet + *")!
      const footer = routed.querySelector("footer")!
      const tables = [...routed.querySelectorAll("table")]
      const table = tables.at(-1)!.getBoundingClientRect()
      const box = footer.getBoundingClientRect()
      const text = document.createRange()
      text.selectNodeContents(footer)
      return {
        last: routed.lastElementChild === footer,
        left: text.getBoundingClientRect().left - table.left,
        below: box.top - table.bottom,
      }
    })
    expect(place.last, tab).toBe(true)
    expect(Math.abs(place.left), tab).toBeLessThanOrEqual(1)
    expect(place.below, tab).toBeGreaterThan(0)
  }
})

// An action's result shows in the toolbar, right after its buttons, on their
// line, where "Updated" was.
test("layout: an action's result shows in the toolbar after its buttons", async ({
  page,
}) => {
  await signIn(page, admin)
  const toolbar = page.locator(".toolbar")
  const box = (item: Locator) =>
    item.evaluate((e) => {
      const r = e.getBoundingClientRect()
      return { left: r.left, right: r.right, middle: r.top + r.height / 2 }
    })
  const agent = page.locator('table.agents tr[data-agent="smoke:agent"]')
  await agent.getByRole("button", { name: "Pause", exact: true }).click()
  const notice = toolbar.locator(".notice")
  await expect(notice).toHaveText("Paused smoke:agent.")
  const last = await box(toolbar.getByRole("button", { name: "Resume All" }))
  const shown = await box(notice)
  expect(shown.left - last.right).toBeGreaterThan(0)
  expect(shown.left - last.right).toBeLessThan(20)
  expect(Math.abs(shown.middle - last.middle)).toBeLessThanOrEqual(2)
  await agent.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(notice).toHaveText("Resumed smoke:agent.")
})

// The Send a Message and Set a Wake forms span the frame and start
// collapsed: one clickable line with their title, which opens them; the
// title in the neutral text color, 2 px further from its fold marker (the
// owner, 2026-11-02), the line padded 6 px (the owner, 2026-11-07).
test("layout: the forms are full width and start collapsed", async ({
  page,
}) => {
  await signIn(page, admin)
  const forms = [
    { tab: "Messages", title: "Send a Message", field: "#send-to" },
    { tab: "Wakes", title: "Set a Wake", field: "#wake-agent" },
  ]
  for (const { tab, title, field } of forms) {
    await openTab(page, tab)
    const form = page.locator("details.panel")
    const summary = form.locator("summary")
    await expect(summary, tab).toHaveText(title)
    await expect(form, tab).not.toHaveAttribute("open")
    await expect(page.locator(field), tab).toBeHidden()
    await expect(summary, tab).toHaveCSS("cursor", "pointer")
    // the label color of the default (dark) theme (--fg-label; the owner,
    // 2026-11-07), not the link color
    await expect(summary, tab).toHaveCSS("color", "rgb(174, 183, 192)")
    await expect(summary.locator("span"), tab).toHaveCSS("margin-left", "2px")
    await expect(summary, tab).toHaveCSS("padding", "8px")
    const widths = await page.evaluate(() => {
      const width = (s: string) =>
        document.querySelector(s)!.getBoundingClientRect().width
      return { form: width("details.panel"), table: width("#frame table") }
    })
    expect(widths.form, tab).toBeCloseTo(widths.table, 0)
    await summary.click()
    await expect(page.locator(field), tab).toBeVisible()
    expect(await overflow(page), tab).toEqual({ frame: 0, page: 0 })
    await summary.click()
    await expect(page.locator(field), tab).toBeHidden()
  }
})

// The tabs have 2 px rounded top corners (the owner, 2026-11-03); the Help
// page's contents links stay square.
// The active tab (the owner, 2026-11-04): 10 px above its text, a 2 px bottom
// border in the frame's color over the frame's top border, still in front
// (z-index 2); the others keep theirs.
test("layout: the active tab has 10 px above its text and a 2 px bottom border", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "Agents")
  const look = (selector: string) =>
    page.locator(selector).evaluate((a) => {
      const s = getComputedStyle(a)
      const probe = document.createElement("span")
      probe.style.color = "var(--panel)"
      document.body.append(probe)
      const panel = getComputedStyle(probe).color
      probe.remove()
      return {
        paddingTop: s.paddingTop,
        bottom: s.borderBottomWidth,
        bottomColor: s.borderBottomColor === panel,
        zIndex: s.zIndex,
      }
    })
  expect(await look("nav:not(.toc) > a.on")).toEqual({
    paddingTop: "10px",
    bottom: "2px",
    bottomColor: true,
    zIndex: "2",
  })
  const other = await look("nav:not(.toc) > a:not(.on) >> nth=0")
  expect(other.paddingTop).toBe("7.2px")
  expect(other.bottom).toBe("1px")
  // the tabs still sit on the frame's top edge
  const tab = (await page.locator("nav:not(.toc) > a.on").boundingBox())!
  const frame = (await page.locator("#frame").boundingBox())!
  expect(tab.y + tab.height).toBeGreaterThanOrEqual(frame.y)
})

test("layout: tabs have 2 px rounded top corners", async ({ page }) => {
  await signIn(page, admin)
  await openTab(page, "Help")
  const radii = (selector: string) =>
    page.locator(selector).evaluateAll((all) =>
      all.map((a) => {
        const s = getComputedStyle(a)
        return [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomRightRadius,
          s.borderBottomLeftRadius,
        ].join(" ")
      }),
    )
  const tabs = await radii("nav:not(.toc) > a")
  expect(tabs.length).toBe(await page.locator("nav:not(.toc) > a").count())
  expect(tabs.length).toBeGreaterThanOrEqual(8)
  expect(new Set(tabs)).toEqual(new Set(["2px 2px 0px 0px"]))
  expect(new Set(await radii("nav.toc a"))).toEqual(
    new Set(["0px 0px 0px 0px"]),
  )
})

/*
 * Help (the owner, 2026-11-02): the last tab, how to use Autocode, with
 * numbered contents at the left (numbers faint, subsections indented, a thin
 * line at their left) that stay in view as the text scrolls; no text heavier
 * than 500.
 */
test("Help: the last tab, with numbered contents that stay in view", async ({
  page,
}) => {
  await signIn(page, admin)
  await expect(page.locator("nav a").last()).toHaveText("Help")
  await openTab(page, "Help")
  await expect(page).toHaveURL(/\/help$/)
  const toc = page.locator("nav.toc")
  await expect(toc.locator("a").first()).toHaveText("1 What Autocode Is")
  await expect(toc.locator("a").last()).toHaveText("7 Troubleshooting")
  const look = await page.evaluate(() => {
    const toc = document.querySelector("nav.toc")!
    const number = (a: Element) => a.querySelector(".n")!
    const top = toc.querySelector("a:not(.sub)")!
    const sub = toc.querySelector("a.sub")!
    const muted = document.createElement("span")
    muted.className = "muted"
    document.body.append(muted)
    const faint = getComputedStyle(muted).color
    muted.remove()
    const left = (e: Element) => e.getBoundingClientRect().left
    const article = document.querySelector("#frame article")!
    return {
      number: getComputedStyle(number(top)).color,
      faint,
      heading: getComputedStyle(article.querySelector("h2 .n")!).color,
      indent: left(number(sub)) - left(number(top)),
      line: getComputedStyle(toc).borderLeftStyle,
      beside: left(article) - toc.getBoundingClientRect().right,
    }
  })
  expect(look.number).toBe(look.faint)
  expect(look.heading).toBe(look.faint)
  expect(look.indent).toBeGreaterThan(8)
  expect(look.line).toBe("solid")
  expect(look.beside).toBeGreaterThan(16)
  // Scrolled down to section 5, the contents stay at the top of the window.
  await page.evaluate(() => document.getElementById("web")!.scrollIntoView())
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
  await expect
    .poll(() => toc.evaluate((e) => Math.round(e.getBoundingClientRect().top)))
    .toBe(16)
  await expect(toc.locator("a").first()).toBeInViewport()
  const heavy = await page.evaluate(() =>
    [...document.querySelectorAll("#frame *")]
      .filter((e) =>
        [...e.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
        ),
      )
      .filter((e) => Number(getComputedStyle(e).fontWeight) > 500)
      .map((e) => e.tagName),
  )
  expect(heavy).toEqual([])
})

// A contents link scrolls its section's heading to the top of the window,
// also when it is the section already in the address.
test("Help: a contents link scrolls to its section", async ({ page }) => {
  await signIn(page, admin)
  await openTab(page, "Help")
  const toc = page.locator("nav.toc")
  const top = (id: string) =>
    page
      .locator(`#frame article #${id}`)
      .evaluate((e) => Math.round(e.getBoundingClientRect().top))
  for (const [name, id] of [
    ["3.3 Wakes", "wakes"],
    ["4.1 Your Commands", "commands"],
    ["1 What Autocode Is", "what"],
    ["3.3 Wakes", "wakes"],
  ]) {
    await toc.getByRole("link", { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/help#${id}$`))
    await expect.poll(() => top(id), name).toBeGreaterThanOrEqual(8)
    await expect.poll(() => top(id), name).toBeLessThanOrEqual(24)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await toc.getByRole("link", { name: "3.3 Wakes", exact: true }).click()
  await expect.poll(() => top("wakes"), "again").toBeLessThanOrEqual(24)
})

// Under 900 px the contents become a wrapping row above the text, without the
// subsections.
test("Help: under 900 px the contents are a row above the text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 800 })
  await signIn(page, admin)
  await openTab(page, "Help")
  const toc = page.locator("nav.toc")
  await expect(toc).toHaveCSS("flex-direction", "row")
  await expect(toc).toHaveCSS("flex-wrap", "wrap")
  await expect(toc.locator("a.sub").first()).toBeHidden()
  await expect(toc.locator("a", { hasText: "Troubleshooting" })).toBeVisible()
  const place = await page.evaluate(() => ({
    toc: document.querySelector("nav.toc")!.getBoundingClientRect().bottom,
    article: document.querySelector("#frame article")!.getBoundingClientRect()
      .top,
  }))
  expect(place.toc).toBeLessThanOrEqual(place.article)
  expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
})

/*
 * History (the owner, 2026-11-04): every server event, newest first, with its
 * time, kind, agent and host (links to their pages), session and data (a
 * summary; the whole data as JSON on a click anywhere in the cell).
 */
test("History: the fixture's events show, newest first, with links to Agents and Hosts", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "History")
  await expect(page.locator("table.history thead th")).toHaveText([
    "Time",
    "Kind",
    "Agent",
    "Host",
    "Session",
    "Data",
  ])
  const times = await page
    .locator("table.history td.time")
    .evaluateAll((all) => all.map((td) => td.getAttribute("title") ?? ""))
  expect(times.length).toBeGreaterThan(5)
  expect([...times].sort().reverse()).toEqual(times)
  // smoke:agent's registration (its kind chosen, so that it is on the page).
  await page
    .getByLabel("Kind", { exact: true })
    .selectOption("agent.registered")
  await expect(page).toHaveURL(/\/history\?kind=agent\.registered$/)
  const registered = page
    .locator("table.history tr[data-entry]")
    .filter({ has: page.locator("td.agent", { hasText: /^smoke:agent$/ }) })
    .first()
  await expect(registered.locator("td.kind")).toHaveText("agent.registered")
  await expect(registered.locator("td.data")).toHaveText(
    "description: made by the smoke test",
  )
  await expect(registered.locator("td.host")).toHaveText("smoke:host:1")
  await registered.locator("td.agent a.id-link").click()
  await expect(page).toHaveURL(/\/agents\?agent=smoke(:|%3A)agent$/)
  await expect(
    page.locator('table.agents tr[data-agent="smoke:agent"]'),
  ).toHaveClass(/\bhighlight\b/)
  await page.goBack()
  await expect(page).toHaveURL(/\/history\?kind=agent\.registered$/)
  await registered.locator("td.host a.id-link").click()
  await expect(page).toHaveURL(/\/hosts\?host=smoke(:|%3A)host(:|%3A)1$/)
  await expect(
    page.locator('table.hosts tr[data-host="smoke:host:1"]'),
  ).toHaveClass(/\bhighlight\b/)
})

/*
 * The filters: an agent pattern (a second after the last key, Enter at once)
 * and a kind (a group like agent.*, or one kind with its count); both go into
 * the address, so Back keeps them; a bad pattern shows the server's message.
 */
test("History: filters by an agent pattern and by kind; the address keeps them", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "History")
  const match = page.getByLabel("Agent", { exact: true })
  await match.fill("smoke:*")
  await expect(page).toHaveURL(/\/history\?match=smoke(:|%3A)\*$/)
  const agents = page.locator("table.history td.agent")
  await expect(agents.first()).toHaveText(/^smoke:/)
  for (const agent of await agents.allTextContents())
    expect(agent).toMatch(/^smoke:/)
  const kind = page.getByLabel("Kind", { exact: true })
  await kind.selectOption("agent.*")
  await expect(page).toHaveURL(/match=smoke(:|%3A)\*&kind=agent\.\*$/)
  const kinds = page.locator("table.history td.kind")
  await expect(kinds.first()).toHaveText(/^agent\./)
  for (const k of await kinds.allTextContents()) expect(k).toMatch(/^agent\./)
  // One kind, with its count in the list.
  const option = kind.locator("option", { hasText: /^agent\.registered \(/ })
  await expect(option).toHaveText(/^agent\.registered \(\d+\)$/)
  await kind.selectOption("agent.registered")
  await expect(kinds.first()).toHaveText("agent.registered")
  // Away and Back: the filters stay.
  await page.getByRole("link", { name: "Wakes", exact: true }).click()
  await page.goBack()
  await expect(match).toHaveValue("smoke:*")
  await expect(kind).toHaveValue("agent.registered")
  await expect(kinds.first()).toHaveText("agent.registered")
  // A bad pattern: the server's message in the toolbar.
  await match.fill("a b")
  await match.press("Enter")
  await expect(page.locator(".toolbar .result .errmsg")).toHaveText(/pattern/)
})

// The toolbar is one row: Refresh at the left, Agent and Kind at the right.
test("History: the toolbar is one row at 1280 and 1024 px", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "History")
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 })
    const middles = await page
      .locator(
        "#frame .toolbar > button, #frame .toolbar > input, " +
          "#frame .toolbar > select",
      )
      .evaluateAll((all) =>
        all.map((e) => {
          const box = e.getBoundingClientRect()
          return Math.round(box.top + box.height / 2)
        }),
      )
    expect(middles.length, `${width}`).toBe(3)
    expect(new Set(middles).size, `${width}: ${middles}`).toBe(1)
  }
})

// A row's Data opens as JSON on a click anywhere in its cell, and folds again.
test("History: a row's Data opens as JSON and folds again", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "History")
  const cell = page.locator("table.history td.data.folds").first()
  const more = cell.locator(".more")
  const summary = (await more.textContent()) ?? ""
  expect(summary).toMatch(/^\w+: /)
  await expect(cell).toHaveCSS("cursor", "pointer")
  await cell.click({ position: { x: 3, y: 3 } })
  await expect(more).toHaveAttribute("aria-expanded", "true")
  await expect(more).toHaveClass(/\bjson\b/)
  const json = (await more.textContent()) ?? ""
  expect(() => JSON.parse(json)).not.toThrow()
  expect(json).toContain("\n  ")
  expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
  await more.click()
  await expect(more).toHaveAttribute("aria-expanded", "false")
  await expect(more).toHaveText(summary)
})

/*
 * Older: with more than 100 entries, the next 100 come under the first; it
 * goes when a page comes back short. The test makes 120 entries of its own
 * (a wake set and cancelled 60 times).
 */
test("History: Older loads the next entries when there are more than 100", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  try {
    for (let i = 0; i < 60; i++) {
      const set = await api.put("/v1/me/wakes/history-paging", {
        headers: bearer(sessionToken),
        data: { text: `Paging ${i}.`, trigger: "fire-only" },
      })
      expect(set.ok(), await set.text()).toBe(true)
      const gone = await api.delete("/v1/me/wakes/history-paging", {
        headers: bearer(sessionToken),
      })
      expect(gone.ok(), await gone.text()).toBe(true)
    }
  } finally {
    await api.dispose()
  }
  await signIn(page, admin)
  await openTab(page, "History")
  const rows = page.locator("table.history tr[data-entry]")
  await expect(rows).toHaveCount(100)
  const older = page.getByRole("button", { name: "Older", exact: true })
  await expect(older).toBeVisible()
  const last = Number(await rows.last().getAttribute("data-entry"))
  await older.click()
  await expect.poll(() => rows.count()).toBeGreaterThan(100)
  // The ones Older added are all older than the first page's last.
  const added = await rows.evaluateAll((all) =>
    all.slice(100).map((r) => Number(r.getAttribute("data-entry"))),
  )
  for (const id of added) expect(id).toBeLessThan(last)
  // Narrowed to these 120, two pages: Older goes after the second.
  await page.getByLabel("Kind", { exact: true }).selectOption("wake.*")
  await page.getByLabel("Agent", { exact: true }).fill("smoke:agent")
  await page.getByLabel("Agent", { exact: true }).press("Enter")
  await expect(rows).toHaveCount(100)
  await older.click()
  await expect.poll(() => rows.count()).toBeGreaterThan(120)
  await expect(older).toHaveCount(0)
})

/*
 * Locks (tier 0c): each lock with its type (a mutex, or N places), its
 * holders (links to Agents; until when, with how long that is from now) and
 * its queue in order. The fixture's mutex gpu-0 has smoke:agent holding it
 * and the long agent in its queue; its semaphore gpu-pool has 2 places, both
 * taken.
 */
test("Locks: a mutex with a holder and one in its queue, and a semaphore of 2 places; agents link to Agents", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "Locks")
  await expect(page.locator("table.locks thead th")).toHaveText([
    "Lock",
    "Type",
    "Holders",
    "Queue",
  ])
  const mutex = page.locator('table.locks tr[data-lock="gpu-0"]')
  await expect(mutex.locator("td.capacity")).toHaveText("Mutex")
  const holder = mutex.locator(".holder")
  await expect(holder).toHaveCount(1)
  await expect(holder.locator("app-agent-link")).toHaveText("smoke:agent")
  const until = holder.locator(".until")
  await expect(until).toHaveText(/^until .+ \(in \d+[smh]( \d+[sm])?\)$/)
  await expect(until).toHaveAttribute(
    "title",
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
  )
  await expect(
    holder.getByRole("button", { name: "Release", exact: true }),
  ).toBeVisible()
  const waiter = mutex.locator("td.queue .waiter")
  await expect(waiter).toHaveCount(1)
  await expect(waiter).toHaveText(
    new RegExp(`^1\\. ${LONG.agent} \\(since .+\\) Remove\\s*$`),
  )
  const pool = page.locator('table.locks tr[data-lock="gpu-pool"]')
  await expect(pool.locator("td.capacity")).toHaveText("2 places")
  await expect(pool.locator(".holder app-agent-link")).toHaveText([
    "smoke:agent",
    LONG.agent,
  ])
  await expect(pool.locator("td.queue")).toHaveText("—")
  expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
  // A holder's link leads to its row on Agents; Back returns.
  await holder.locator("a.id-link").click()
  await expect(page).toHaveURL(/\/agents\?agent=smoke(:|%3A)agent$/)
  await expect(
    page.locator('table.agents tr[data-agent="smoke:agent"]'),
  ).toHaveClass(/\bhighlight\b/)
  await page.goBack()
  await expect(page).toHaveURL(/\/locks$/)
  await waiter.locator("a.id-link").click()
  await expect(
    page.locator(`table.agents tr[data-agent="${LONG.agent}"]`),
  ).toHaveClass(/\bhighlight\b/)
})

// The Lock filter: a pattern, in the address, so Back keeps it; a bad one
// shows the server's message in the toolbar.
test("Locks: filters by a lock pattern; the address keeps it", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "Locks")
  const match = page.getByLabel("Lock", { exact: true })
  await match.fill("gpu-p*")
  await expect(page).toHaveURL(/\/locks\?match=gpu-p\*$/)
  await expect(page.locator("table.locks tr[data-lock]")).toHaveCount(1)
  await expect(page.locator("table.locks tr[data-lock]")).toHaveAttribute(
    "data-lock",
    "gpu-pool",
  )
  await page.getByRole("link", { name: "Wakes", exact: true }).click()
  await page.goBack()
  await expect(match).toHaveValue("gpu-p*")
  await expect(page.locator("table.locks tr[data-lock]")).toHaveCount(1)
  await match.fill("disk-*")
  await match.press("Enter")
  // The row that says so: the only one, across the table.
  await expect(page.locator("table.locks tbody td[colspan]")).toHaveText(
    "No lock matches disk-*.",
  )
  await expect(page.locator("table.locks tr[data-lock]")).toHaveCount(0)
  await match.fill("a b")
  await match.press("Enter")
  await expect(page.locator(".toolbar .result .errmsg")).toHaveText(/pattern/)
})

/*
 * Release (the owner's): it asks first; then the hold is freed, the agent is
 * told, and the next in the queue holds the lock. The notice to the agent is
 * from autocode, which is no agent link on the Messages page.
 */
test("Locks: Release asks first, then frees the hold and the queue moves up", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const name = "smoke-release"
  try {
    await acquire(api, sessionToken, name, { ttl: "1h" })
    await acquire(api, longToken, name, { ttl: "30m" })
    await signIn(page, admin)
    await openTab(page, "Locks")
    const lock = page.locator(`table.locks tr[data-lock="${name}"]`)
    const release = lock.getByRole("button", { name: "Release", exact: true })
    const asked: string[] = []
    page.once("dialog", (dialog) => {
      asked.push(dialog.message())
      void dialog.dismiss()
    })
    await release.click()
    await expect.poll(() => asked.length).toBe(1)
    expect(asked[0]).toBe(
      `Release smoke:agent's hold on ${name}?\n\n` +
        "The agent is told and the next in the queue gets it.",
    )
    await expect(lock.locator(".holder app-agent-link")).toHaveText(
      "smoke:agent",
    )
    page.once("dialog", (dialog) => void dialog.accept())
    await release.click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      `Released smoke:agent's hold on ${name}.`,
    )
    await expect(lock.locator(".holder app-agent-link")).toHaveText(LONG.agent)
    await expect(lock.locator(".until")).toHaveText(/\(in (30m|29m)\)$/)
    await expect(lock.locator("td.queue")).toHaveText("—")
    await openTab(page, "Messages")
    const granted = page
      .locator("table.messages tr[data-message]")
      .filter({ hasText: `lock "${name}" granted` })
      .first()
    await expect(granted.locator("td.sender")).toHaveText("autocode")
    await expect(granted.locator("td.sender a")).toHaveCount(0)
    await expect(granted.locator("td.recipient")).toHaveText(LONG.agent)
  } finally {
    for (const agent of ["smoke:agent", LONG.agent])
      await api.post(`/v1/locks/${name}/release`, {
        headers: bearer(admin),
        data: { agent },
      })
    await api.dispose()
  }
})

/*
 * Remove (the owner, 2026-11-05): the owner takes a waiter out of a lock's
 * queue after confirming; the agent is told, the others move up, and nothing
 * else changes. Remove looks like Release and lines up in the queue's grid.
 */
test("Locks: Remove takes a waiter out of the queue", async ({ page }) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const name = "smoke-queue"
  const third = "smoke:waiter"
  try {
    const issued = await api.post(
      "/v1/hosts/smoke:host:1/sessions/ses_smoke_waiter/token",
      { headers: bearer(consumer), data: {} },
    )
    expect(issued.ok(), await issued.text()).toBe(true)
    const token = (await issued.json()).token
    const registered = await api.post("/v1/agents", {
      headers: bearer(token),
      data: { id: third, description: "waits for locks" },
    })
    expect([200, 201], await registered.text()).toContain(registered.status())
    await acquire(api, longToken, name, { ttl: "1h" })
    await acquire(api, sessionToken, name, { ttl: "1h" })
    await acquire(api, token, name, { ttl: "1h" })
    await signIn(page, admin)
    await openTab(page, "Locks")
    // The other locks' agents, to see that they stay as they are.
    const others = () =>
      page
        .locator(
          `table.locks tr[data-lock]:not([data-lock="${name}"]) ` +
            "app-agent-link",
        )
        .allTextContents()
    const before = await others()
    expect(before.length).toBeGreaterThan(0)
    const lock = page.locator(`table.locks tr[data-lock="${name}"]`)
    const waiters = lock.locator("td.queue .waiter")
    await expect(waiters).toHaveText([
      /^1\. smoke:agent \(since .+\) Remove\s*$/,
      /^2\. smoke:waiter \(since .+\) Remove\s*$/,
    ])
    const removes = lock.getByRole("button", { name: "Remove", exact: true })
    await expect(removes).toHaveCount(2)
    // As Release looks, and lined up, one under the other.
    const look = (button: Locator) =>
      button.evaluateAll((all) =>
        all.map((b) => {
          const s = getComputedStyle(b)
          const box = b.getBoundingClientRect()
          return {
            left: Math.round(box.left),
            height: Math.round(box.height),
            style: [s.fontSize, s.padding, s.borderWidth, s.backgroundColor],
          }
        }),
      )
    const [release] = await look(
      lock.getByRole("button", { name: "Release", exact: true }),
    )
    const [first, second] = await look(removes)
    expect(first!.left).toBe(second!.left)
    for (const remove of [first!, second!]) {
      expect(remove.height).toBe(release!.height)
      expect(remove.style).toEqual(release!.style)
    }
    const asked: string[] = []
    page.once("dialog", (dialog) => {
      asked.push(dialog.message())
      void dialog.accept()
    })
    await removes.first().click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      `Took smoke:agent out of the queue of ${name}.`,
    )
    expect(asked).toEqual([
      `Take smoke:agent out of the queue of ${name}?\n\n` +
        "The agent is told; the others move up.",
    ])
    await expect(waiters).toHaveText([
      /^1\. smoke:waiter \(since .+\) Remove\s*$/,
    ])
    await expect(lock.locator(".holder app-agent-link")).toHaveText(LONG.agent)
    expect(await others()).toEqual(before)
    // The agent was told, by a notice from autocode.
    await openTab(page, "Messages")
    const told = page
      .locator("table.messages tr[data-message]")
      .filter({ hasText: `lock "${name}": out of the queue` })
      .first()
    await expect(told.locator("td.sender")).toHaveText("autocode")
    await expect(told.locator("td.recipient")).toHaveText("smoke:agent")
  } finally {
    await api.delete(`/v1/agents/${third}`, { headers: bearer(admin) })
    for (const agent of ["smoke:agent", LONG.agent])
      await api.post(`/v1/locks/${name}/release`, {
        headers: bearer(admin),
        data: { agent },
      })
    await api.dispose()
  }
})

// With every lock released, the page says how locks come and go; the
// fixture's locks come back after.
test("Locks: the empty page after every lock is released", async ({ page }) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  try {
    for (let round = 0; round < 5; round++) {
      const res = await api.get("/v1/locks", { headers: bearer(admin) })
      const { locks } = await res.json()
      if (!locks.length) break
      for (const lock of locks)
        for (const entry of [...lock.queue, ...lock.holders])
          await api.post(`/v1/locks/${lock.name}/release`, {
            headers: bearer(admin),
            data: { agent: entry.agent },
          })
    }
    await signIn(page, admin)
    await page.getByRole("link", { name: "Locks", exact: true }).click()
    const empty = page.locator("table.locks tbody td[colspan]")
    await expect(empty).toHaveText(
      "No locks. Agents create one with autocode_lock action=acquire; " +
        "it is gone when nobody holds it or waits.",
    )
    await expect(page.locator("#frame footer")).toHaveText(
      /^Updated \d+s ago\.$/,
    )
  } finally {
    await makeLocks(api)
    await api.dispose()
  }
})

/*
 * Messages are text only (the owner, 2026-11-07): no Kind column, no file in a
 * Text cell, and the Send a Message form has nothing to attach.
 */
test("Messages: every message is text; no Kind column, no file to send", async ({
  page,
}) => {
  await signIn(page, admin)
  await openTab(page, "Messages")
  await expect(page.locator("table.messages thead th")).not.toContainText([
    "Kind",
  ])
  await expect(page.locator("table.messages td.kind")).toHaveCount(0)
  const texts = page.locator("table.messages td.text")
  await expect(texts.first()).toBeVisible()
  await expect(texts.filter({ hasText: / file$/ })).toHaveCount(0)
  // ID, Time, From, To, Subject, Text, Size and State.
  await expect(page.locator("table.messages thead th")).toHaveCount(8)
  const form = page.locator("details.panel")
  await form.locator("summary", { hasText: "Send a Message" }).click()
  await expect(form.locator("input[type=file]")).toHaveCount(0)
  expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
})

/*
 * A wake has no end (the owner, 2026-11-07): the Set a Wake form has no End
 * field, and the table no End column.
 */
test("Wakes: no End in the Set a Wake form or the table", async ({ page }) => {
  await signIn(page, admin)
  await openTab(page, "Wakes")
  await expect(page.locator("table.wakes thead th")).not.toContainText(["End"])
  await expect(page.locator("table.wakes td.end")).toHaveCount(0)
  await expect(page.locator("table.wakes tr.group th").first()).toHaveAttribute(
    "colspan",
    "9",
  )
  const form = page.locator("details.panel")
  await form.locator("summary", { hasText: "Set a Wake" }).click()
  await expect(form.locator("label")).toHaveText([
    "Agent ID",
    "Name",
    "Trigger",
    "Text",
    "Check",
  ])
  await expect(page.getByLabel("End", { exact: true })).toHaveCount(0)
  expect(await overflow(page)).toEqual({ frame: 0, page: 0 })
})

// The Settings page shows the settings the server has, one row each, and no
// others (the owner removed four on 2026-11-07).
test("Settings: one row per setting the server has", async ({ page }) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  let keys: string[] = []
  try {
    const res = await api.get("/v1/settings", { headers: bearer(admin) })
    expect(res.ok(), await res.text()).toBe(true)
    keys = Object.keys((await res.json()).schema).sort()
  } finally {
    await api.dispose()
  }
  await signIn(page, admin)
  await openTab(page, "Settings")
  const shown = await page
    .locator("table.settings tr[data-key]")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-key") ?? ""))
  expect([...shown].sort()).toEqual(keys)
})

// A mode setting (the owner, 2026-11-08): Agent… shows a list of the
// registered agents; the pick is saved as agent:<id>, then reset. Both lists
// fit in the Value column at 1280 px.
test("Settings: a mode's Agent… lists the agents and saves agent:<id>", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, admin)
  await openTab(page, "Settings")
  const row = page.locator('table.settings tr[data-key="approval_mode"]')
  const kind = row.getByLabel("Value of approval_mode", { exact: true })
  await expect(kind.locator("option")).toHaveText([
    "ask",
    "approve",
    "Agent…",
    "Job…",
  ])
  await kind.selectOption("agent:")
  const agent = row.getByLabel("Agent for approval_mode", { exact: true })
  await expect(agent.locator("option")).toContainText(["smoke:agent"])
  await agent.selectOption("smoke:agent")
  try {
    await row.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("status").first()).toHaveText(
      "Saved approval_mode.",
    )
    await expect(row.locator("td.from")).toHaveText("set server-wide")
    const cell = await row.locator("td.value").boundingBox()
    for (const list of [kind, agent]) {
      const box = await list.boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(cell!.x + cell!.width)
    }
    // the agent's list shows the agent: wider than the first, which is as
    // wide as its words
    const [k, a] = [await kind.boundingBox(), await agent.boundingBox()]
    expect(a!.width).toBeGreaterThan(k!.width)
    expect(k!.width).toBeLessThan(140)
  } finally {
    await row.getByRole("button", { name: "Reset", exact: true }).click()
    await expect(row.locator("td.from")).toHaveText("built-in default")
  }
})

// The owner, 2026-11-09: in the Daily Cap cell the share sits at the right,
// the cap at the left, the bar under both; the cell is 150 px wide.
test("layout: the Costs tab's Daily Cap has its share at the right, 150 px wide", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const cap = (daily_usd: number | null) =>
    api.patch("/v1/settings", {
      headers: bearer(admin),
      data: { agents: { "smoke:agent": { daily_usd } } },
    })
  try {
    expect((await cap(100)).ok()).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
    await signIn(page, admin)
    await openTab(page, "Costs")
    const cell = page.locator('table.costs tr[data-agent="smoke:agent"] td.cap')
    await expect(cell.locator(".share")).toHaveText(/^\d+\.\d%$/)
    const box = await cell.evaluate((td) => {
      const r = td.getBoundingClientRect()
      const css = getComputedStyle(td)
      const right = r.right - parseFloat(css.paddingRight)
      const left = r.left + parseFloat(css.paddingLeft)
      const of = (sel: string) => td.querySelector(sel)!.getBoundingClientRect()
      return {
        share: right - of(".share").right,
        amount: of(".amount").left - left,
        bar: right - of(".bar").right,
      }
    })
    expect(Math.abs(box.share), "the share at the right").toBeLessThanOrEqual(1)
    expect(Math.abs(box.amount), "the cap at the left").toBeLessThanOrEqual(1)
    expect(Math.abs(box.bar), "the bar to the right edge").toBeLessThanOrEqual(
      1,
    )
    // 150 px wide (the owner, 2026-11-09)
    const widths = await page
      .locator("table.costs td.cap")
      .evaluateAll((cells) =>
        cells.map((c) => Math.round(c.getBoundingClientRect().width)),
      )
    expect(widths.length).toBeGreaterThan(0)
    for (const w of widths) expect(w, "td.cap").toBe(150)
  } finally {
    await cap(null)
    await api.dispose()
  }
})

// Tier 0g (the owner, 2026-11-08): the Costs tab follows a model step live
// (no reload); Days shows the spend per day; the Agents tab's column too.
test("Costs: spend and context live, an agent's days, and the Agents column", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const step = (usd: number, context: number) =>
    api.post("/v1/hosts/smoke:host:1/events", {
      headers: bearer(consumer),
      data: {
        instance: "i1",
        events: [
          {
            type: "cost",
            session: "ses_smoke1",
            usd,
            context,
            limit: 200_000,
            model: "fake/main",
          },
        ],
      },
    })
  try {
    await signIn(page, admin)
    await openTab(page, "Costs")
    const row = page.locator('table.costs tr[data-agent="smoke:agent"]')
    await expect(row.locator("td.agent")).toHaveText("smoke:agent")
    const before = Number(
      (await row.locator("td.total").innerText()).replace(/[$,]/g, ""),
    )
    expect((await step(0.25, 60_000)).ok()).toBe(true)
    // within one refresh (5 s), without a reload
    await expect(row.locator("td.total")).toHaveText(
      `$${(before + 0.25).toFixed(2)}`,
      { timeout: 8000 },
    )
    // no Context column here (the owner, 2026-11-08): it is on Agents
    await expect(row.locator("td.context")).toHaveCount(0)
    // when the data was read, the server's time, right of Refresh (the
    // owner, 2026-11-08)
    await expect(page.locator(".toolbar .clock")).toHaveText(
      /^\d\d-[A-Z][a-z]{2}-\d\d \d\d:\d\d:\d\d [A-Z][A-Z0-9+-]{1,5}$/,
    )
    const [refresh, clock] = [
      await page
        .locator(".toolbar button", { hasText: "Refresh" })
        .boundingBox(),
      await page.locator(".toolbar .clock").boundingBox(),
    ]
    expect(clock!.x).toBeGreaterThan(refresh!.x + refresh!.width)
    // the totals row and the Agent filter (the owner, 2026-11-08)
    await expect(page.locator("table.costs tfoot tr.totals")).toContainText(
      "Total (",
    )
    await page.locator("#cost-match").fill("smoke:*")
    await expect(page).toHaveURL(/\/costs\?match=smoke:\*$/)
    await expect(
      page.locator("table.costs tbody tr[data-agent]").first(),
    ).toHaveAttribute("data-agent", /^smoke:/)
    await row.getByRole("button", { name: "Days", exact: true }).click()
    const days = page.locator('tr.days[data-agent="smoke:agent"]')
    await expect(
      days.locator("table.cost-days tbody tr").first(),
    ).toContainText("$")
    // its day as every date in the web UI: 05-Nov-26 (the owner, 2026-11-09)
    await expect(
      days.locator("table.cost-days tbody tr td").first(),
    ).toHaveText(/^\d\d-[A-Z][a-z]{2}-\d\d$/)
    await openTab(page, "Agents")
    const agent = page.locator('tr[data-agent="smoke:agent"]')
    await expect(agent.locator("td.context")).toHaveText("60K/100K/200K")
    await expect(agent.locator("td.spend")).toContainText(" today / $")
    // a click on Spend: the Costs tab with this agent's row highlighted
    await agent.locator("td.spend a").click()
    await expect(page).toHaveURL(/\/costs\?agent=smoke:agent$/)
    await expect(
      page.locator('table.costs tr[data-agent="smoke:agent"]'),
    ).toHaveClass(/highlight/)
    await openTab(page, "Agents")
    await expect(agent.locator("td.model")).toHaveText("main")
    await expect(agent.locator("td.model")).toHaveAttribute(
      "title",
      "fake/main",
    )
    // the ID column keeps room for the ID's parts (not two letters a line)
    const id = await page
      .locator('tr[data-agent="smoke:agent"] td.id')
      .boundingBox()
    expect(id!.width).toBeGreaterThanOrEqual(112)
  } finally {
    await api.dispose()
  }
})

// The owner, 2026-11-08: toolbar text fields 15rem on every tab, without
// "(empty shows all)"; the Unregistered and Offline boxes.
test("toolbars: text fields 15rem, no '(empty shows all)'; Unregistered and Offline boxes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, admin)
  for (const tab of ["Agents", "Locks", "Costs", "History"]) {
    await openTab(page, tab)
    const field = page.locator('.toolbar input[type="text"]').first()
    await expect(field, tab).toHaveCSS("width", "240px")
    expect(await field.getAttribute("placeholder"), tab).not.toContain(
      "empty shows all",
    )
  }
  await openTab(page, "Agents")
  await expect(
    page.getByRole("checkbox", { name: "Unregistered" }),
  ).not.toBeChecked()
  await openTab(page, "Costs")
  await expect(
    page.getByRole("checkbox", { name: "Unregistered" }),
  ).toBeChecked()
  await page.getByRole("link", { name: "Hosts", exact: true }).click()
  await expect(
    page.getByRole("checkbox", { name: "Offline" }),
  ).not.toBeChecked()
})

// What the plugin reports when smoke:agent's turn asks something (tier 0d):
// the question tool's form, or a permission prompt.
async function openAsk(api: APIRequestContext, event: Record<string, unknown>) {
  const res = await api.post("/v1/hosts/smoke:host:1/events", {
    headers: bearer(consumer),
    data: {
      instance: "i1",
      events: [{ type: "ask.opened", session: "ses_smoke1", ...event }],
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
}

// A question of smoke:agent's, with two options; its header is unique.
function question(header: string) {
  return {
    kind: "question",
    ref: `frm_${header}`,
    title: "Questions",
    questions: [
      {
        key: "q0",
        header,
        question: `Which fold split should I use (${header})?`,
        multiple: false,
        options: [
          { label: "v3", description: "folds v3" },
          { label: "v2", description: "the old ones" },
        ],
      },
    ],
  }
}

// A permission prompt of smoke:agent's.
function permission(command: string) {
  return {
    kind: "permission",
    ref: `per_${command.replace(/\W+/g, "_")}`,
    title: "shell",
    action: "shell",
    resources: [command],
    save: ["rm *"],
  }
}

// An approval smoke:agent asks for itself; its ID.
async function askApproval(api: APIRequestContext, text: string) {
  const res = await api.post("/v1/me/approvals", {
    headers: bearer(sessionToken),
    data: { text, options: ["now", "tonight"], expires: "1h" },
  })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()).approval.id as string
}

// The open asks in the owner's inbox.
async function openAsks(api: APIRequestContext) {
  const res = await api.get("/v1/inbox", { headers: bearer(admin) })
  return ((await res.json()).items as any[]).filter((i) =>
    ["question", "permission", "approval"].includes(i.kind),
  )
}

// Every open ask answered (rejected where it can be), so smoke:agent is no
// longer waiting.
async function answerAsks(api: APIRequestContext) {
  for (const ask of await openAsks(api))
    await api.post(`/v1/asks/${ask.id}/answer`, {
      headers: bearer(admin),
      data: ask.kind === "question" ? { text: "done" } : { decision: "reject" },
    })
}

/*
 * Asks (tier 0d): a question in the Inbox, with its kind, agent, Sent To and
 * options; a click on an option answers it at once, and it is gone, after a
 * reload too; Closed shows its answer.
 */
test("Inbox: a question answered by an option button", async ({ page }) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const header = `Fold ${Date.now()}`
  try {
    await openAsk(api, question(header))
    await signIn(page, admin)
    await openTab(page, "Inbox")
    const row = page.locator("table.inbox tr[data-item]", { hasText: header })
    await expect(row.locator("td.kind")).toHaveText("Question")
    await expect(row.locator("td.agent")).toHaveText("smoke:agent")
    await expect(row.locator("td.sent-to")).toHaveText("owner")
    await expect(row.locator(".title")).toHaveText(
      `Question from smoke:agent: ${header}`,
    )
    const options = row.locator("button.option")
    await expect(options).toHaveText(["v3", "v2"])
    await options.first().click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      "Answered question from smoke:agent.",
    )
    await expect(row).toHaveCount(0)
    await page.reload()
    await expect(
      page.locator("#frame table.inbox tr[data-item]").first(),
    ).toBeVisible()
    await expect(row).toHaveCount(0)
    await page.getByLabel("Closed", { exact: true }).check()
    await expect(row.locator(".answer")).toHaveText("Answer: v3 (by the owner)")
    await expect(row.locator("td.actions")).toHaveText("answered")
    await expect(row.locator("button")).toHaveCount(0)
  } finally {
    await answerAsks(api)
    await api.dispose()
  }
})

// A permission prompt: its action and command; Allow Once lets it run.
test("Inbox: a permission allowed once", async ({ page }) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const command = `rm -rf build-${Date.now()}`
  try {
    await openAsk(api, permission(command))
    await signIn(page, admin)
    await openTab(page, "Inbox")
    const row = page.locator("table.inbox tr[data-item]", { hasText: command })
    await expect(row.locator("td.kind")).toHaveText("Permission")
    await expect(row.locator(".action")).toHaveText("Action: shell")
    await expect(row.locator(".resources code")).toHaveText([command])
    for (const name of ["Allow Once", "Allow Always", "Reject"])
      await expect(row.getByRole("button", { name, exact: true })).toBeVisible()
    await expect(
      row.getByRole("textbox", { name: "Reason to reject" }),
    ).toBeVisible()
    await row.getByRole("button", { name: "Allow Once", exact: true }).click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      "Answered permission from smoke:agent.",
    )
    await expect(row).toHaveCount(0)
    await page.getByLabel("Closed", { exact: true }).check()
    await expect(row.locator(".answer")).toHaveText(
      "Answer: once (by the owner)",
    )
  } finally {
    await answerAsks(api)
    await api.dispose()
  }
})

// An approval smoke:agent asked for: approved with an option and a note; the
// agent's own view of it says so.
test("Inbox: an approval approved with an option", async ({ page }) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const what = `Deploy the new model ${Date.now()}.`
  try {
    const id = await askApproval(api, what)
    await signIn(page, admin)
    await openTab(page, "Inbox")
    const row = page.locator("table.inbox tr[data-item]", { hasText: what })
    await expect(row.locator("td.kind")).toHaveText("Approval")
    await expect(row.locator(".ask-text")).toHaveText(what)
    // its text once (the owner, 2026-11-07): the title names the agent
    await expect(row.locator(".title")).toHaveText("Approval for smoke:agent")
    expect((await row.locator("td.item").innerText()).split(what).length).toBe(
      2,
    )
    await expect(row.locator(".expires")).toHaveText(
      /^expires .+ \(in (59m|1h)\)$/,
    )
    await row.getByLabel("tonight", { exact: true }).check()
    await row.getByRole("textbox", { name: "Note" }).fill("after 22:00")
    await row.getByRole("button", { name: "Approve", exact: true }).click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      "Answered approval from smoke:agent.",
    )
    await expect(row).toHaveCount(0)
    const res = await api.get(`/v1/me/approvals/${id}`, {
      headers: bearer(sessionToken),
    })
    const { approval } = await res.json()
    expect(approval).toMatchObject({ option: "tonight", note: "after 22:00" })
    expect(approval.state).toMatch(/^(answered|approved)$/)
  } finally {
    await answerAsks(api)
    await api.dispose()
  }
})

/*
 * Someone answered first (here the owner, through the API): the page's answer
 * is refused with the server's message, and the ask is gone after the list
 * reloads.
 */
test("Inbox: an ask answered first elsewhere says so and goes", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const header = `First ${Date.now()}`
  try {
    await openAsk(api, question(header))
    await signIn(page, admin)
    await openTab(page, "Inbox")
    const row = page.locator("table.inbox tr[data-item]", { hasText: header })
    await expect(row.locator("button.option")).toHaveCount(2)
    const ask = (await openAsks(api)).find((a) => a.title.includes(header))
    const first = await api.post(`/v1/asks/${ask.id}/answer`, {
      headers: bearer(admin),
      data: { text: "v2" },
    })
    expect(first.ok(), await first.text()).toBe(true)
    await row.locator("button.option").first().click()
    await expect(page.locator(".toolbar .errmsg")).toHaveText(
      /already answered by the owner/,
    )
    await expect(row).toHaveCount(0)
  } finally {
    await answerAsks(api)
    await api.dispose()
  }
})

/*
 * An ask sent to another agent (question_mode=agent:<id> for smoke:agent):
 * Sent To links to that agent, and its note (it cannot answer) shows under
 * the title; the owner can still answer.
 */
test("Inbox: an ask sent to another agent shows Sent To and its note", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const header = `Routed ${Date.now()}`
  const mode = (value: string | null) =>
    api.patch("/v1/settings", {
      headers: bearer(admin),
      data: { agents: { "smoke:agent": { question_mode: value } } },
    })
  try {
    expect((await mode(`agent:${LONG.agent}`)).ok()).toBe(true)
    await openAsk(api, question(header))
    const ask = (await openAsks(api)).find((a) => a.title.includes(header))
    expect(ask.routed).toBe(`agent:${LONG.agent}`)
    const escalated = await api.post(`/v1/asks/${ask.id}/escalate`, {
      headers: bearer(longToken),
      data: { text: "not my area" },
    })
    expect(escalated.ok(), await escalated.text()).toBe(true)
    await signIn(page, admin)
    await openTab(page, "Inbox")
    const row = page.locator("table.inbox tr[data-item]", { hasText: header })
    await expect(row.locator("td.sent-to")).toHaveText(LONG.agent)
    await expect(row.locator("td.sent-to a.id-link")).toHaveAttribute(
      "href",
      /\/agents\?agent=/,
    )
    await expect(row.locator(".note")).toHaveText(
      `Note: ${LONG.agent} cannot answer: not my area`,
    )
    await row.locator("button.option").first().click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      "Answered question from smoke:agent.",
    )
    await expect(row).toHaveCount(0)
  } finally {
    await mode(null)
    await answerAsks(api)
    await api.dispose()
  }
})

/*
 * The Inbox with a question, a permission and an approval open: it fits 1280
 * px (at 1024 px it may scroll inside the frame, never the window); its
 * buttons are in Title Case (an option is the agent's words) and their text
 * is 15 px.
 */
test("Inbox: the layout with a question, a permission and an approval at 1280 and 1024", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const stamp = Date.now()
  try {
    await openAsk(api, question(`Layout ${stamp}`))
    await openAsk(api, permission(`rm -rf layout-${stamp}`))
    await askApproval(api, `Approve the layout ${stamp}.`)
    await signIn(page, admin)
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      await openTab(page, "Inbox")
      const asks = page.locator("table.inbox tr[data-item]", {
        hasText: String(stamp),
      })
      await expect(asks).toHaveCount(3)
      const over = await overflow(page)
      if (width === 1280)
        expect(over, `${width}`).toEqual({ frame: 0, page: 0 })
      else expect(over.page, `${width}`).toBe(0)
      const buttons = await asks
        .locator("button:not(.option)")
        .evaluateAll((all) =>
          all.map((b) => ({
            text: (b.textContent ?? "").trim(),
            size: getComputedStyle(b).fontSize,
          })),
        )
      expect(buttons.map((b) => b.text)).toEqual([
        "Answer",
        "Allow Once",
        "Allow Always",
        "Reject",
        "Approve",
        "Reject",
      ])
      for (const b of buttons) {
        expect(titleCase(b.text), b.text).toBe(true)
        expect(b.size, b.text).toBe("15px")
      }
      const sizes = await asks
        .locator('.ask-text, .action, .resources, label, input[type="text"]')
        .evaluateAll((all) => [
          ...new Set(all.map((e) => getComputedStyle(e).fontSize)),
        ])
      expect(sizes, `${width}`).toEqual(["15px"])
    }
  } finally {
    await answerAsks(api)
    await api.dispose()
  }
})

/*
 * Jobs (tier 0f): the owner sets a job through the Set a Job form, on an
 * online host (machine and folder); the job shows where it runs, its model,
 * trigger, next run and destination; the server's message when it refuses.
 */
test("Jobs: a job set through the form on the fixture's host", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const name = `smoke-form-${Date.now()}`
  try {
    // The fixture's host has no plugin: an empty report says it is there.
    const seen = await api.post("/v1/hosts/smoke:host:1/events", {
      headers: bearer(consumer),
      data: { instance: "i1", events: [] },
    })
    expect(seen.ok(), await seen.text()).toBe(true)
    await signIn(page, admin)
    await openTab(page, "Jobs")
    const form = page.locator("details.panel")
    await form.locator("summary", { hasText: "Set a Job" }).click()
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("owner")
    await expect(page.getByLabel("Time Limit", { exact: true })).toHaveValue(
      "1h",
    )
    await expect(page.getByLabel("Run Cap", { exact: true })).toHaveValue("off")
    await expect(page.getByLabel("Delete Session")).toBeChecked()
    await page.getByLabel("Name", { exact: true }).fill(name)
    await page
      .getByLabel("Host", { exact: true })
      .selectOption({ label: "smoke — /work" })
    await page.getByLabel("Model", { exact: true }).fill("test/model")
    await page.getByLabel("Prompt", { exact: true }).fill("Report.")
    await page.getByLabel("Trigger", { exact: true }).fill("idle 30m")
    const set = form.getByRole("button", { name: "Set Job", exact: true })
    await set.click()
    await expect(form.locator(".errmsg")).toHaveText(
      /every, at, cron or fire-only/,
    )
    await page.getByLabel("Trigger", { exact: true }).fill("every 1h")
    await page.getByLabel("Run Cap", { exact: true }).fill("2")
    await set.click()
    await expect(form.locator(".notice")).toHaveText(`Set job ${name}.`)
    const row = page.locator(`table.jobs tr[data-job="${name}"]`)
    await expect(row.locator("td.where")).toHaveText("smoke /work")
    await expect(row.locator("td.model")).toHaveText("test/model")
    await expect(row.locator("td.trigger")).toHaveText("every 1h")
    await expect(row.locator("td.next")).toHaveText(/\(in (59m|1h)\)$/)
    await expect(row.locator("td.to")).toHaveText("owner")
    await expect(row.locator("td.last")).toHaveText("—")
    const res = await api.get("/v1/jobs", { headers: bearer(admin) })
    const job = (await res.json()).jobs.find((j: any) => j.name === name)
    expect(job).toMatchObject({ run_usd: 2, delete_session: true })
  } finally {
    await deleteJob(api, name)
    await api.dispose()
  }
})

/*
 * Run Now starts a run with the text typed beside it (the fixture's host has
 * no plugin, so it stays starting); its row shows below, and the job's Last
 * Run links to it; a second Run Now is refused while it runs; the Job filter
 * shows that job's runs.
 */
test("Jobs: Run Now starts a run; a second one is refused", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const name = `smoke-run-${Date.now()}`
  try {
    await setJob(api, name)
    await signIn(page, admin)
    await openTab(page, "Jobs")
    const row = page.locator(`table.jobs tr[data-job="${name}"]`)
    await row.getByRole("textbox", { name: "Text for the run" }).fill("Now.")
    await row.getByRole("button", { name: "Run Now", exact: true }).click()
    const notice = page.locator(".toolbar .notice")
    await expect(notice).toHaveText(
      new RegExp(`^Started run ${name}:\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d\\.$`),
    )
    const id = (await notice.textContent())!.slice("Started run ".length, -1)
    const run = page.locator(`table.runs tr[data-run="${id}"]`)
    await expect(run.locator("td.state")).toHaveText(/^(Starting|Running)$/)
    await expect(run.locator("td.by")).toHaveText("owner")
    await expect(row.locator("td.last")).toHaveText(/^(Starting|Running) /)
    await row.locator("td.last a.run-link").click()
    await expect(page).toHaveURL(/\/jobs\?run=/)
    await expect(run).toHaveClass(/\bhighlight\b/)
    await row.getByRole("button", { name: "Run Now", exact: true }).click()
    await expect(page.locator(".toolbar .errmsg")).toHaveText(
      new RegExp(`job ${name} is running: ${id}|started this minute`),
    )
    await page.getByLabel("Job", { exact: true }).selectOption(name)
    await expect(page.locator("table.runs tr[data-run]")).toHaveCount(1)
    await expect(run).toBeVisible()
  } finally {
    await deleteJob(api, name)
    await api.dispose()
  }
})

// Edit fills the Set a Job form with the job; Set Job replaces it. Delete
// asks first, then the job is gone.
test("Jobs: Edit fills the form; Delete asks first", async ({ page }) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const name = `smoke-edit-${Date.now()}`
  try {
    await setJob(api, name, {
      description: "Edited by the smoke test",
      trigger: "every 2h",
      run_usd: 3,
      delete_session: false,
    })
    await signIn(page, admin)
    await openTab(page, "Jobs")
    const row = page.locator(`table.jobs tr[data-job="${name}"]`)
    await row.getByRole("button", { name: "Edit", exact: true }).click()
    const form = page.locator("details.panel")
    await expect(form).toHaveAttribute("open", "")
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name)
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
      "Edited by the smoke test",
    )
    await expect(page.getByLabel("Host", { exact: true })).toHaveValue(
      "smoke:host:1",
    )
    await expect(page.getByLabel("Trigger", { exact: true })).toHaveValue(
      "every 2h",
    )
    await expect(page.getByLabel("Run Cap", { exact: true })).toHaveValue("3")
    await expect(page.getByLabel("Delete Session")).not.toBeChecked()
    await page.getByLabel("Trigger", { exact: true }).fill("every 3h")
    await form.getByRole("button", { name: "Set Job", exact: true }).click()
    await expect(form.locator(".notice")).toHaveText(`Set job ${name}.`)
    await expect(row.locator("td.trigger")).toHaveText("every 3h")
    const asked: string[] = []
    page.once("dialog", (dialog) => {
      asked.push(dialog.message())
      void dialog.dismiss()
    })
    const remove = row.getByRole("button", { name: "Delete", exact: true })
    await remove.click()
    await expect.poll(() => asked.length).toBe(1)
    expect(asked[0]).toBe(`Delete job ${name}?\n\nIts runs' history stays.`)
    await expect(row).toHaveCount(1)
    page.once("dialog", (dialog) => void dialog.accept())
    await remove.click()
    await expect(page.locator(".toolbar .notice")).toHaveText(
      `Deleted job ${name}.`,
    )
    await expect(row).toHaveCount(0)
  } finally {
    await deleteJob(api, name)
    await api.dispose()
  }
})

/*
 * The Jobs page with two more jobs and their runs: it fits 1280 px (at 1024
 * px it may scroll inside the frame, never the window); its buttons are in
 * Title Case and their text is 15 px.
 */
test("Jobs: the layout with jobs and runs at 1280 and 1024", async ({
  page,
}) => {
  const api = await request.newContext({ baseURL: base, timeout: 10_000 })
  const stamp = Date.now()
  const names = [`layout-check-of-a-long-job-name-${stamp}`, `smoke-${stamp}`]
  try {
    await setJob(api, names[0]!, {
      trigger: 'cron "0 9 * * 1-5"',
      to: LONG.agent,
      variant: "high",
      agent: "build",
      run_usd: 5,
    })
    await setJob(api, names[1]!, { trigger: "every 30m" })
    for (const name of names) {
      const res = await api.post(`/v1/jobs/${name}/run`, {
        headers: bearer(admin),
        data: { text: "For the layout." },
      })
      expect(res.status(), await res.text()).toBe(201)
    }
    await signIn(page, admin)
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      await openTab(page, "Jobs")
      await expect(
        page.locator("table.runs tr[data-run]", { hasText: String(stamp) }),
      ).toHaveCount(2)
      const over = await overflow(page)
      if (width === 1280)
        expect(over, `${width}`).toEqual({ frame: 0, page: 0 })
      else expect(over.page, `${width}`).toBe(0)
      const buttons = await page
        .locator("table.jobs button, table.runs button")
        .evaluateAll((all) =>
          all.map((b) => ({
            text: (b.textContent ?? "").trim(),
            size: getComputedStyle(b).fontSize,
          })),
        )
      expect(buttons.length).toBeGreaterThan(6)
      for (const b of buttons) {
        expect(titleCase(b.text), b.text).toBe(true)
        expect(b.size, b.text).toBe("15px")
      }
    }
  } finally {
    for (const name of names) await deleteJob(api, name)
    await api.dispose()
  }
})

async function refused(page: Page, token: string, says: string) {
  await page.goto("/")
  await page.getByLabel("Token").fill(token)
  await page.getByRole("button", { name: "Sign In", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText(says)
  await expect(page.getByRole("link", { name: "Agents" })).toHaveCount(0)
  await expect(page.getByLabel("Token")).toBeVisible()
}

// The web UI takes the admin token only: the consumer token is the plugins'
// credential.
test("the consumer token is refused", async ({ page }) => {
  await refused(page, consumer, "That is the consumer token")
})

test("an agent's session token is refused", async ({ page }) => {
  await refused(page, sessionToken, "session token")
})

// How far the frame and the page scroll sideways (0 when they fit).
async function overflow(page: Page) {
  return page.evaluate(() => {
    const frame = document.getElementById("frame")!
    return {
      frame: frame.scrollWidth - frame.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
}

// Every page fits 1280 px. At 1024 px, Agents and Wakes may be wider than
// the frame, since IDs break only after ':' and '_' (the owner, 2026-11-03:
// "Fit only at 1280 px"); see the next check.
for (const width of [1280]) {
  test(`layout: every page fits ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await signIn(page, admin)
    const row = page.locator(`table.agents tr[data-agent="${LONG.agent}"]`)
    await expect(row.locator("td.folder")).toHaveText(LONG.directory)
    await expect(row.locator("td.session")).toHaveText(LONG.session)
    expect(await overflow(page), "Agents").toEqual({ frame: 0, page: 0 })
    await openTab(page, "Hosts")
    const host = page.locator(`table.hosts tr[data-host="${LONG.host}"]`)
    await expect(host.locator("td.folder")).toHaveText(LONG.directory)
    expect(await overflow(page), "Hosts").toEqual({ frame: 0, page: 0 })
    for (const tab of [
      "Inbox",
      "Messages",
      "Locks",
      "Wakes",
      "Jobs",
      "Costs",
      "History",
      "Settings",
      "Help",
    ]) {
      await openTab(page, tab)
      expect(await overflow(page), tab).toEqual({ frame: 0, page: 0 })
    }
  })
}

// At 1024 px a page wider than the frame scrolls inside the frame, never the
// window, and its last column can be reached (the owner, 2026-11-03).
test("layout: at 1024 px a wide page scrolls inside the frame", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 })
  await signIn(page, admin)
  const row = page.locator(`table.agents tr[data-agent="${LONG.agent}"]`)
  await expect(row.locator("td.session")).toHaveText(LONG.session)
  for (const tab of [
    "Agents",
    "Hosts",
    "Inbox",
    "Messages",
    "Locks",
    "Wakes",
    "Jobs",
    "Costs",
    "History",
    "Settings",
    "Help",
  ]) {
    await openTab(page, tab)
    expect((await overflow(page)).page, tab).toBe(0)
  }
  await openTab(page, "Agents")
  const last = row.getByRole("button", { name: "Unregister", exact: true })
  await page.locator("#frame").evaluate((f) => {
    f.scrollLeft = f.scrollWidth
  })
  const frame = (await page.locator("#frame").boundingBox())!
  const button = (await last.boundingBox())!
  expect(button.x + button.width).toBeLessThanOrEqual(frame.x + frame.width)
})

test("layout: wrapped action buttons have space between their lines", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await signIn(page, admin)
  const buttons = page.locator(
    `table.agents tr[data-agent="${LONG.agent}"] td.actions button`,
  )
  await expect(buttons).toHaveCount(4)
  const boxes = await buttons.evaluateAll((all) =>
    all.map((b) => b.getBoundingClientRect()),
  )
  // The space above each button that starts a new line (a button beside the
  // one before it starts above that one's bottom).
  const gaps = boxes
    .slice(1)
    .map((b, i) => b.top - boxes[i]!.bottom)
    .filter((gap) => gap > -1)
  expect(gaps.length, "the buttons wrap at 900 px").toBeGreaterThan(0)
  // 0.3rem less one pixel (the owner's choice).
  for (const gap of gaps) expect(gap).toBeCloseTo(3.8, 1)
})

test("layout: the header's items are centered vertically", async ({ page }) => {
  await signIn(page, admin)
  await expect(page.locator("header .server")).toBeVisible()
  const offsets = await page.evaluate(() => {
    const header = document.querySelector("header.top")!
    const mid = (r: DOMRect) => r.top + r.height / 2
    const center = mid(header.getBoundingClientRect())
    const title = [...document.querySelector("header h1")!.childNodes].find(
      (n) =>
        n.nodeType === Node.TEXT_NODE && n.textContent!.includes("Autocode"),
    )!
    const range = document.createRange()
    range.selectNodeContents(title)
    const boxes: Record<string, DOMRect> = {
      title: range.getBoundingClientRect(),
    }
    for (const s of [".server", ".who", "button.small", "button.theme"])
      boxes[s] = header.querySelector(s)!.getBoundingClientRect()
    return Object.fromEntries(
      Object.entries(boxes).map(([k, r]) => [k, mid(r) - center]),
    )
  })
  // The version sits half its 3 px top margin lower (the owner's choice).
  const { ".server": version, ...rest } = offsets
  expect(version!).toBeGreaterThanOrEqual(0.5)
  expect(version!).toBeLessThanOrEqual(2.5)
  for (const [item, offset] of Object.entries(rest))
    expect(Math.abs(offset), item).toBeLessThanOrEqual(1)
})

/*
 * The favicon's triangle before the title, in light and dark: in its
 * pink-red, 1.25rem, with no shift and no margin of its own (the owner,
 * 2026-11-02), so a little taller than the 1.25rem title's capitals, roughly
 * centered on them, the title's gap before the word;
 * hidden from assistive tech, so the title still reads "Autocode" and its
 * version.
 */
test("layout: the header shows the favicon before the title", async ({
  page,
}) => {
  await signIn(page, admin)
  const title = page.locator("header h1")
  const icon = title.locator("svg.logo")
  await expect(icon).toBeVisible()
  await expect(icon).toHaveAttribute("aria-hidden", "true")
  await expect(title).toHaveText("Autocode v0.1.0-dev")
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
    "Autocode v0.1.0-dev",
  )
  // The same triangle as the favicon.
  const href = await page.locator('link[rel="icon"]').getAttribute("href")
  const favicon = decodeURIComponent(href!.slice("data:image/svg+xml,".length))
  const d = /<path\b[^>]*\bd="([^"]*)"/.exec(favicon)![1]!
  await expect(icon.locator("path")).toHaveAttribute("d", d)
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "Light or dark" }).click()
    await expect(icon.locator("path"), theme).toHaveCSS(
      "stroke",
      "rgb(232, 67, 110)",
    )
    const place = await page.evaluate(() => {
      const h1 = document.querySelector("header h1")!
      const word = [...h1.childNodes].find(
        (n) =>
          n.nodeType === Node.TEXT_NODE && n.textContent!.includes("Autocode"),
      )!
      const range = document.createRange()
      range.selectNodeContents(word)
      const text = range.getBoundingClientRect()
      // The baseline: where an empty box after the same word in the same
      // font sits, measured from the top of the word.
      const copy = document.createElement("div")
      copy.style.font = getComputedStyle(h1).font
      copy.style.position = "absolute"
      copy.textContent = "Autocode"
      const empty = document.createElement("span")
      empty.style.display = "inline-block"
      copy.append(empty)
      document.body.append(copy)
      const copied = document.createRange()
      copied.selectNodeContents(copy.firstChild!)
      const ascent =
        empty.getBoundingClientRect().bottom -
        copied.getBoundingClientRect().top
      copy.remove()
      // The capital letters' height above the baseline, in the same font.
      const ctx = document.createElement("canvas").getContext("2d")!
      ctx.font = getComputedStyle(h1).font
      const caps = ctx.measureText("A").actualBoundingBoxAscent
      // The triangle as drawn: its path and the 2-unit outline around it.
      const svg = h1.querySelector("svg.logo")!
      const unit = svg.getBoundingClientRect().height / 16
      const path = svg.querySelector("path")!.getBoundingClientRect()
      const size = Number.parseFloat(getComputedStyle(h1).fontSize)
      return {
        gap: text.left - (path.right + unit),
        height: (path.bottom - path.top + 2 * unit) / size,
        // its middle against the middle of the capitals
        off: (path.top + path.bottom) / 2 - (text.top + ascent - caps / 2),
      }
    })
    expect(place.gap, theme).toBeGreaterThanOrEqual(3)
    expect(place.gap, theme).toBeLessThanOrEqual(10)
    expect(place.height, theme).toBeGreaterThanOrEqual(0.8)
    expect(place.height, theme).toBeLessThanOrEqual(0.9)
    expect(Math.abs(place.off), theme).toBeLessThanOrEqual(3)
    const box = await icon.evaluate((e) => {
      const c = getComputedStyle(e)
      return [c.width, c.height, c.top, c.marginRight]
    })
    expect(box, theme).toEqual(["20px", "20px", "0px", "0px"])
  }
})

/*
 * The title and every bold text (headings, table headers, the forms' titles,
 * the Inbox's titles, strong and b) have font weight 500, and nothing is
 * heavier (the owner, 2026-11-02): on the sign-in form and every tab, with the
 * forms open.
 */
test("layout: the title and every bold text have font weight 500", async ({
  page,
}) => {
  // Elements with text of their own heavier than 500.
  const heavy = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((e) =>
          [...e.childNodes].some(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
          ),
        )
        .filter((e) => Number(getComputedStyle(e).fontWeight) > 500)
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
    )
  const weight = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((e) => getComputedStyle(e).fontWeight)
  await page.goto("/")
  await expect(page.locator(".sign-in h2")).toBeVisible()
  expect(await heavy(), "sign-in").toEqual([])
  expect(await weight(".sign-in h2")).toBe("500")
  await signIn(page, admin)
  expect(await weight("header h1")).toBe("500")
  for (const tab of [
    "Hosts",
    "Agents",
    "Inbox",
    "Messages",
    "Locks",
    "Wakes",
    "Jobs",
    "History",
  ]) {
    await page.getByRole("link", { name: tab, exact: true }).click()
    await expect(page.locator("table th").first()).toBeVisible()
    const panel = page.locator("details.panel summary")
    if (await panel.count()) {
      await panel.click()
      expect(await weight("details.panel summary"), tab).toBe("500")
    }
    expect(await weight("table th"), tab).toBe("500")
    if (tab === "Inbox") {
      await expect(page.locator("table.inbox .title").first()).toBeVisible()
      expect(await weight("table.inbox .title")).toBe("500")
    }
    expect(await heavy(), tab).toEqual([])
  }
  await page.getByRole("link", { name: "Settings" }).click()
  await expect(page.locator("h2.first")).toBeVisible()
  expect(await weight("h2.first")).toBe("500")
  expect(await heavy(), "Settings").toEqual([])
})

/*
 * The sign-in form is centered on the page, across and down (the owner,
 * 2026-11-02), clear of the header, whose light/dark button still works; on a
 * window too short for that it sits below the header, still centered across,
 * and can be scrolled to.
 */
test("layout: the sign-in form is centered on the page", async ({ page }) => {
  const form = page.locator("#frame.sign-in")
  for (const [width, height] of [
    [1280, 800],
    [1024, 700],
  ]) {
    await page.setViewportSize({ width: width!, height: height! })
    await page.goto("/")
    await expect(form).toBeVisible()
    const box = (await form.boundingBox())!
    const header = (await page.locator("header.top").boundingBox())!
    expect(
      Math.abs(box.x + box.width / 2 - width! / 2),
      `${width}`,
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(box.y + box.height / 2 - height! / 2),
      `${width}`,
    ).toBeLessThanOrEqual(1)
    expect(box.y, `${width}`).toBeGreaterThan(header.y + header.height)
  }
  const dark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  )
  await page.getByRole("button", { name: "Light or dark" }).click()
  // the theme's class follows a moment after the click
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(!dark)
  await page.setViewportSize({ width: 1024, height: 420 })
  const header = (await page.locator("header.top").boundingBox())!
  const box = (await form.boundingBox())!
  expect(box.y).toBeGreaterThan(header.y + header.height)
  // still centered across
  expect(Math.abs(box.x + box.width / 2 - 1024 / 2)).toBeLessThanOrEqual(1)
  await page
    .getByRole("button", { name: "Sign In", exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole("button", { name: "Sign In", exact: true }),
  ).toBeInViewport()
})

// The sign-in form's texts (the owner, 2026-11-02): only its heading above
// the field, no visible label on the field (named Token for assistive tech),
// and a short "Stay signed in".
test("sign-in: the form says only what is needed", async ({ page }) => {
  await page.goto("/")
  const form = page.locator("#frame.sign-in")
  await expect(form.locator("p")).toHaveCount(0)
  await expect(form.locator("label", { hasText: /^Token$/ })).toHaveCount(0)
  await expect(page.getByLabel("Token", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Token", { exact: true })).toHaveAttribute(
    "placeholder",
    "admin token",
  )
  await expect(
    page.getByRole("checkbox", { name: "Stay signed in", exact: true }),
  ).toBeVisible()
})

// The token field is 30% shorter than the row it used to fill (570 px to
// 25rem, the owner, 2026-11-02), with Sign In right after it.
test("layout: the sign-in token field is 30% shorter", async ({ page }) => {
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto("/")
    const field = (await page
      .getByLabel("Token", { exact: true })
      .boundingBox())!
    const button = (await page
      .getByRole("button", { name: "Sign In", exact: true })
      .boundingBox())!
    expect(field.width, `${width}`).toBeCloseTo(400, 0)
    expect(button.x - (field.x + field.width), `${width}`).toBeCloseTo(9.6, 0)
  }
})

// The sign-in form's heading has 0.6rem below it, down to the token field (the
// owner, 2026-11-02).
test("layout: the sign-in heading has 0.6rem below it", async ({ page }) => {
  await page.goto("/")
  const heading = page.locator("#frame.sign-in h2")
  await expect(heading).toHaveCSS("margin-bottom", "9.6px")
  const h = (await heading.boundingBox())!
  const field = (await page.getByLabel("Token", { exact: true }).boundingBox())!
  expect(field.y - (h.y + h.height)).toBeCloseTo(9.6, 0)
})

// The sign-in form is just as wide as its content: the token row and the
// frame's padding and border (the owner, 2026-11-02).
test("layout: the sign-in form just fits its content", async ({ page }) => {
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto("/")
    const frame = (await page.locator("#frame.sign-in").boundingBox())!
    const field = (await page
      .getByLabel("Token", { exact: true })
      .boundingBox())!
    const button = (await page
      .getByRole("button", { name: "Sign In", exact: true })
      .boundingBox())!
    // 1.25rem of padding and a 1 px border on each side
    const row = button.x + button.width - field.x
    expect(frame.width, `${width}`).toBeCloseTo(row + 2 * 20 + 2, 0)
    expect(field.x - frame.x, `${width}`).toBeCloseTo(21, 0)
  }
})

// Section headings (h2) are 1rem, on the sign-in form and in Settings (the
// owner, 2026-11-02).
test("layout: h2 headings are 1rem", async ({ page }) => {
  const sizes = () =>
    page
      .locator("h2")
      .evaluateAll((all) => all.map((e) => getComputedStyle(e).fontSize))
  await page.goto("/")
  await expect(page.locator(".sign-in h2")).toBeVisible()
  expect(await sizes()).toEqual(["16px"])
  await signIn(page, admin)
  await page.getByRole("link", { name: "Settings" }).click()
  await expect(page.locator("h2.first")).toBeVisible()
  const all = await sizes()
  expect(all.length).toBeGreaterThanOrEqual(3)
  for (const size of all) expect(size).toBe("16px")
})

// All text but headings is 15 px: notes and the header's server ID too.
test("layout: the text is 15 px", async ({ page }) => {
  const sizes = (selectors: string[]) =>
    page.evaluate(
      (all) =>
        Object.fromEntries(
          all.map((s) => {
            const e = document.querySelector(s)
            return [s, e ? getComputedStyle(e).fontSize : "missing"]
          }),
        ),
      selectors,
    )
  await signIn(page, admin)
  await expect(page.locator("table.agents td.desc").first()).toBeVisible()
  await expect(page.locator("header .server")).toBeVisible()
  const agents = await sizes([
    "body",
    "table.agents th",
    "table.agents td.desc",
    "nav a",
    "label[for=match]",
    "#match",
    ".toolbar button",
    "#frame footer",
    "header .server",
    "header .who",
  ])
  await openTab(page, "Hosts")
  const hosts = await sizes([
    "#frame .muted",
    "table.hosts tr.group th",
    "table.hosts td.folder",
  ])
  await openTab(page, "Inbox")
  const inbox = await sizes([
    "label[for=show-closed]",
    "table.inbox .title",
    "table.inbox .body",
    "table.inbox textarea",
  ])
  await openTab(page, "Messages")
  const messages = await sizes([
    "details.panel summary",
    "label[for=send-to]",
    "#send-to",
    "#send-text",
    "table.messages td.subject",
  ])
  await openTab(page, "Locks")
  const locks = await sizes([
    "label[for=lock-match]",
    "#lock-match",
    "table.locks td.capacity",
    "table.locks .until",
    "table.locks .waiter",
  ])
  await openTab(page, "Wakes")
  const wakes = await sizes([
    "#wake-trigger",
    "#wake-text",
    "table.wakes tr.group th",
    "table.wakes td.text",
  ])
  await openTab(page, "Jobs")
  const jobs = await sizes([
    "table.jobs td.where",
    "table.jobs td.trigger",
    "table.jobs input[type=text]",
    "details.panel summary",
  ])
  await openTab(page, "History")
  const history = await sizes([
    "label[for=history-match]",
    "#history-match",
    "#history-kind",
    "table.history td.data",
    "table.history td.agent",
  ])
  await openTab(page, "Help")
  const help = await sizes([
    "nav.toc a",
    "nav.toc a.sub",
    "#frame article p",
    "#frame article li",
    "#frame article td",
  ])
  for (const [item, size] of Object.entries({
    ...agents,
    ...hosts,
    ...inbox,
    ...messages,
    ...locks,
    ...wakes,
    ...jobs,
    ...history,
    ...help,
  }))
    expect(size, item).toBe("15px")
})

test("layout: a page's first item has no top margin", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of TABS) {
    await openTab(page, tab)
    const margin = await page.evaluate(() => {
      const routed = document.querySelector("#frame > router-outlet + *")!
      return getComputedStyle(routed.firstElementChild!).marginTop
    })
    expect(margin, tab).toBe("0px")
  }
})

test("layout: buttons are as tall as the text fields beside them", async ({
  page,
}) => {
  const height = (item: Locator) =>
    item.evaluate((e) => e.getBoundingClientRect().height)
  await page.goto("/")
  const token = await height(page.getByLabel("Token"))
  expect(
    await height(page.getByRole("button", { name: "Sign In", exact: true })),
  ).toBeCloseTo(token, 1)
  await signIn(page, admin)
  const filter = await height(page.locator("#match"))
  const refresh = page.getByRole("button", { name: "Refresh" })
  expect(await height(refresh)).toBeCloseTo(filter, 1)
  await page.locator("#match").fill("smoke:*")
  await page.locator("#match").press("Enter")
  const showAll = page.getByRole("button", { name: "Show All", exact: true })
  await expect(showAll).toBeVisible()
  expect(await height(showAll)).toBeCloseTo(filter, 1)
})

test("the Agents filter applies as you type, a second after the last key", async ({
  page,
}) => {
  await signIn(page, admin)
  const long = page.locator(`table.agents tr[data-agent="${LONG.agent}"]`)
  await expect(long).toBeVisible()
  await page.locator("#match").pressSequentially("smoke:*")
  await expect(long).toHaveCount(0)
  await expect(page.locator('tr[data-agent="smoke:agent"]')).toBeVisible()
})

// Title Case: each word starts with a capital, except a few small words that
// are neither first nor last.
const SMALL = new Set(
  "a an the and but or nor for of in on at to by as per via".split(" "),
)
function titleCase(heading: string): boolean {
  const words = heading.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w))
  return words.every(
    (w, i) =>
      /^[A-Z]/.test(w) || (SMALL.has(w) && i > 0 && i < words.length - 1),
  )
}

test("headings, table headers and buttons are in Title Case on every page", async ({
  page,
}) => {
  const headings = async () =>
    page.locator("h1, h2, h3, thead th, button, summary").evaluateAll((all) =>
      all.map((e) => {
        // Code, the header's server ID and an ask's options (the agent's
        // words) are data: they count as one capitalized word.
        const copy = e.cloneNode(true) as Element
        if (copy.matches(".data")) return "Data"
        for (const data of copy.querySelectorAll("code, small, .data"))
          data.replaceWith("Data")
        return (copy.textContent ?? "").trim()
      }),
    )
  await page.goto("/")
  await expect(page.getByLabel("Token")).toBeVisible()
  const seen = [...(await headings())]
  await signIn(page, admin)
  for (const tab of TABS) {
    await openTab(page, tab)
    seen.push(...(await headings()))
  }
  expect(seen.filter((h) => h && !titleCase(h))).toEqual([])
})

test("the Hosts and Agents pages have no page heading", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of ["Hosts", "Agents"]) {
    await openTab(page, tab)
    await expect(page.locator("#frame h2"), tab).toHaveCount(0)
  }
})

test("the header shows v before the version; the title stays Autocode", async ({
  page,
}) => {
  await signIn(page, admin)
  await expect(page.locator("header .server")).toHaveText("v0.1.0-dev")
  for (const tab of TABS) {
    await openTab(page, tab)
    await expect(page).toHaveTitle("Autocode")
  }
})

test("no page writes a hyphen where a dash belongs", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of TABS) {
    await openTab(page, tab)
    const shown = await page.evaluate(() => document.body.innerText)
    expect(shown.match(/\S - \S/g) ?? [], tab).toEqual([])
  }
})

test("the favicon is a flat pink-red outlined triangle, transparent", async ({
  page,
}) => {
  await page.goto("/")
  const href = await page.locator('link[rel="icon"]').getAttribute("href")
  const prefix = "data:image/svg+xml,"
  expect(href?.startsWith(prefix)).toBe(true)
  const svg = decodeURIComponent(href!.slice(prefix.length))
  expect(svg).toContain('fill="none"')
  expect(svg).toContain('stroke="#e8436e"')
  expect(svg).not.toMatch(/<(rect|circle|ellipse)\b/)
  // Bold: a 2 px outline on its 16 px grid.
  expect(svg).toContain('stroke-width="2"')
  // Flat: one closed path through three corners, no inner edge.
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)]
  expect(paths.length).toBe(1)
  const d = paths[0]![1]!
  expect(d.match(/M/gi)?.length, d).toBe(1)
  expect(d.trim().endsWith("Z"), d).toBe(true)
  expect(d.match(/-?\d+(\.\d+)?/g)?.length, d).toBe(6)
})

// Room above every table: 1rem from what comes before it (the owner's choice,
// 2026-11-02; it was 0.8rem).
test("layout: tables have room above them", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of TABS) {
    await openTab(page, tab)
    const gaps = await page.locator("#frame table").evaluateAll((tables) =>
      tables.flatMap((table) => {
        let before = table.previousElementSibling
        while (before && before.getBoundingClientRect().height === 0)
          before = before.previousElementSibling
        if (!before) return []
        const top = table.getBoundingClientRect().top
        return [top - before.getBoundingClientRect().bottom]
      }),
    )
    expect(gaps.length, tab).toBeGreaterThan(0)
    for (const gap of gaps) expect(gap, tab).toBeCloseTo(16, 0)
  }
})

// Table cells: 0.5rem (8 px) on all four sides (the owner's choice).
test("layout: table cells have their padding", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of TABS) {
    await openTab(page, tab)
    const paddings = await page
      .locator("#frame th, #frame td")
      .evaluateAll((cells) => [
        ...new Set(cells.map((c) => getComputedStyle(c).padding)),
      ])
    expect(paddings, tab).toEqual(["8px"])
  }
})

// The frame: 1.25rem (20 px) on all four sides (the owner's choice), on the
// sign-in page and on every tab.
test("layout: the frame has its padding", async ({ page }) => {
  const padding = () =>
    page.locator("#frame").evaluate((e) => getComputedStyle(e).padding)
  await page.goto("/")
  await expect(page.getByLabel("Token")).toBeVisible()
  expect(await padding(), "Sign In").toBe("20px")
  await signIn(page, admin)
  for (const tab of TABS) {
    await openTab(page, tab)
    expect(await padding(), tab).toBe("20px")
  }
})

// The filter, then the Unregistered box at the right (the owner,
// 2026-11-08).
test("layout: the Agents toolbar has Refresh at the left, the filter and Unregistered at the right", async ({
  page,
}) => {
  const box = (item: Locator) =>
    item.evaluate((e) => {
      const r = e.getBoundingClientRect()
      return { left: r.left, right: r.right }
    })
  await signIn(page, admin)
  const toolbar = await box(page.locator(".toolbar"))
  const refresh = await box(page.getByRole("button", { name: "Refresh" }))
  const label = await box(page.locator(".toolbar label[for=match]"))
  const field = await box(page.locator("#match"))
  const gone = await box(page.locator(".toolbar label[for=show-unregistered]"))
  expect(refresh.left - toolbar.left, "Refresh").toBeLessThanOrEqual(1)
  expect(toolbar.right - gone.right, "Unregistered").toBeLessThanOrEqual(1)
  expect(gone.left, "Unregistered").toBeGreaterThanOrEqual(field.right)
  expect(label.left, "the label").toBeGreaterThan(
    (toolbar.left + toolbar.right) / 2,
  )
  expect(label.right, "the label").toBeLessThanOrEqual(field.left)
  await page.locator("#match").fill("smoke:*")
  await page.locator("#match").press("Enter")
  const showAll = page.getByRole("button", { name: "Show All", exact: true })
  await expect(showAll).toBeVisible()
  expect(toolbar.right - (await box(showAll)).right).toBeLessThanOrEqual(1)
})

// All text but headings is 15 px, the buttons' too; the light/dark switch is
// an icon.
test("layout: every button's text is 15 px", async ({ page }) => {
  await signIn(page, admin)
  const sizes: Record<string, string[]> = {}
  for (const tab of TABS) {
    await openTab(page, tab)
    sizes[tab] = await page
      .locator("button:not(.theme)")
      .evaluateAll((all) => [
        ...new Set(all.map((b) => getComputedStyle(b).fontSize)),
      ])
  }
  expect(sizes).toEqual(Object.fromEntries(TABS.map((t) => [t, ["15px"]])))
})

// Settings: Save and Reset sit as close as the Agents row buttons and are as
// tall as the edit field; the Value column is 25rem (400 px; the owner,
// 2026-11-07) at 1280 px.
test("layout: Settings' Save and Reset beside the field, in a wide Value column", async ({
  page,
}) => {
  const box = (item: Locator) =>
    item.evaluate((e) => {
      const r = e.getBoundingClientRect()
      return { left: r.left, right: r.right, height: r.height, width: r.width }
    })
  await signIn(page, admin)
  // The Agents row buttons' space between buttons on one line (they may wrap).
  const rowGap = await page
    .locator(`table.agents tr[data-agent="${LONG.agent}"] .row-buttons`)
    .evaluate((e) => Number.parseFloat(getComputedStyle(e).columnGap))
  expect(rowGap).toBeGreaterThan(0)
  await openTab(page, "Settings")
  const value = page.locator(
    'table.settings tr[data-key="min_interval"] td.value',
  )
  const field = await box(value.getByLabel("Value of min_interval"))
  const save = await box(value.getByRole("button", { name: "Save" }))
  const reset = await box(value.getByRole("button", { name: "Reset" }))
  expect(reset.left - save.right, "Save to Reset").toBeCloseTo(rowGap, 0)
  expect(save.height, "Save").toBeCloseTo(field.height, 0)
  expect(reset.height, "Reset").toBeCloseTo(field.height, 0)
  expect((await box(value)).width, "the Value column").toBeCloseTo(400, 0)
})

// The header: the title "Autocode" is 17 px; the "admin" badge has no border.
test("layout: the header's title is 1.25rem, the version has a 3 px top margin, the admin badge has no border", async ({
  page,
}) => {
  await signIn(page, admin)
  await expect(page.locator("header .who")).toHaveText("admin")
  const style = await page.evaluate(() => {
    const who = getComputedStyle(document.querySelector("header .who")!)
    return {
      title: getComputedStyle(document.querySelector("header h1")!).fontSize,
      version: getComputedStyle(document.querySelector("header h1 small")!)
        .marginTop,
      border: who.borderTopStyle,
    }
  })
  expect(style).toEqual({ title: "20px", version: "3px", border: "none" })
})

/*
 * A checked checkbox is a neutral grey (the theme's dim text color; the owner,
 * 2026-11-02), on the sign-in form and on the Inbox, in dark (the default) and
 * light. (No setting is a switch since the owner's 2026-11-07 changes.)
 */
test("checkboxes are a neutral grey", async ({ page }) => {
  const dark = "rgb(154, 164, 174)"
  const light = "rgb(102, 102, 102)"
  await page.goto("/")
  const stay = page.locator(".sign-in input[type=checkbox]")
  await expect(stay).toHaveCSS("accent-color", dark)
  await signIn(page, admin)
  await page.getByRole("link", { name: "Inbox" }).click()
  const closed = page.getByLabel("Closed", { exact: true })
  await expect(closed).toHaveCSS("accent-color", dark)
  await page.getByRole("button", { name: "Light or dark" }).click()
  await expect(closed).toHaveCSS("accent-color", light)
})

// Dropdowns draw their own arrow, the same on every browser, with its right
// end 9 px from the border: 5 px further in than the native one (about 4 px in
// Chromium), which sat too far right on the Mac.
test("dropdowns draw their arrow 9 px from the right border", async ({
  page,
}) => {
  await signIn(page, admin)
  await page.getByRole("link", { name: "Settings" }).click()
  // The Setting list of agents' own values (no setting's value is a list
  // since the mode settings take agent:<id> too, 2026-11-07).
  const select = page.locator("#agent-value-key")
  await expect(select).toHaveCSS("appearance", "none")
  await expect(select).toHaveCSS("background-image", /svg/)
  await expect(select).toHaveCSS(
    "background-position-x",
    /^(right 9px|calc\(100% - 9px\))$/,
  )
  // The text stops before the arrow.
  const padding = await select.evaluate((e) =>
    Number.parseFloat(getComputedStyle(e).paddingRight),
  )
  expect(padding).toBeGreaterThanOrEqual(9 + 9 + 4)
})

// The header's right side: 3 px more space from "admin" to Sign Out than from
// Sign Out to the light/dark icon (its glyph, not its button's padding).
test("layout: the header's admin, Sign Out and icon are spaced as chosen", async ({
  page,
}) => {
  await signIn(page, admin)
  await expect(page.locator("header .who")).toBeVisible()
  const gaps = await page.evaluate(() => {
    const header = document.querySelector("header.top")!
    const who = header.querySelector(".who")!.getBoundingClientRect()
    const out = header.querySelector("button.small")!.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(header.querySelector("button.theme")!)
    const icon = range.getBoundingClientRect()
    return { before: out.left - who.right, after: icon.left - out.right }
  })
  expect(gaps.before - gaps.after, JSON.stringify(gaps)).toBeCloseTo(3, 0)
})

// Buttons in the light theme have a lighter border than before (#888).
test("buttons in the light theme have a light border", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark")
  })
  const button = page.getByRole("button", { name: "Sign In", exact: true })
  await expect(button).toHaveCSS("border-top-color", "rgb(170, 170, 170)")
})

// Times show the viewer's own time zone: Pacific time here.
test.describe("in Pacific time", () => {
  test.use({ timezoneId: "America/Los_Angeles" })

  test("times carry the viewer's time zone", async ({ page }) => {
    const time = /^\d\d-[A-Z][a-z]{2}-\d\d \d\d:\d\d:\d\d PT$/
    await signIn(page, admin)
    const agent = page.locator('table.agents tr[data-agent="smoke:agent"]')
    await expect(agent.locator("td.time").first()).toHaveText(time)
    await expect(agent.locator("td.time").last()).toHaveText(time)
    await openTab(page, "Hosts")
    const host = page.locator('table.hosts tr[data-host="smoke:host:1"]')
    await expect(host.locator("td.time")).toHaveText(time)
    await openTab(page, "Inbox")
    await expect(page.locator("table.inbox td.time").first()).toHaveText(time)
    await openTab(page, "Messages")
    await expect(page.locator("table.messages td.time").first()).toHaveText(
      time,
    )
    await openTab(page, "Wakes")
    const wake = page.locator('table.wakes tr[data-wake="smoke-check"]')
    await expect(wake.locator("td.next")).toHaveText(time)
    await openTab(page, "History")
    await expect(page.locator("table.history td.time").first()).toHaveText(time)
    await openTab(page, "Jobs")
    const job = page.locator('table.jobs tr[data-job="smoke-report"]')
    await expect(job.locator("td.next")).toHaveText(
      /^\d\d-[A-Z][a-z]{2}-\d\d \d\d:\d\d:\d\d PT \(in \S+( \S+)?\)$/,
    )
    await openTab(page, "Locks")
    const until = page.locator('table.locks tr[data-lock="gpu-0"] .until')
    await expect(until).toHaveText(
      /^until \d\d-[A-Z][a-z]{2}-\d\d \d\d:\d\d:\d\d PT \(in \S+( \S+)?\)$/,
    )
  })
})
