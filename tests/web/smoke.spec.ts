/*
 * The web UI in a real browser against a real server: sign-in, the Hosts and
 * Agents pages, a settings change, refused tokens, and the layout (the pages
 * fit their frame, the frame's padding, the header's items are centered, the
 * main text is 15 px, a page's first item has no top margin, buttons are as
 * tall as text fields, headings are in Title Case).
 */
import {
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

// An agent with values as long as real ones, for the layout checks.
const LONG = {
  host: "layout:host:1",
  session: "ses_e7d5a9981ffeMI0at2ZTpikxTp",
  agent: "live:mymbp4:glm-5.3:20261028T1314",
  directory:
    "/Users/someone/MY-Solaris/projects/my/autocode/source/__out/live/project",
}

/*
 * The fixture, without OpenCode: a host says hello, gets a token for one of its
 * sessions, and that session registers smoke:agent; a second host does the same
 * for the long agent. min_interval goes back to its default, so every run
 * starts the same way.
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
        machine: "mymbp4",
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
    const longRegistered = await api.post("/v1/agents", {
      headers: bearer((await longIssued.json()).token),
      data: { id: LONG.agent, description: "live check of tier 0a" },
    })
    expect([200, 201], await longRegistered.text()).toContain(
      longRegistered.status(),
    )
    const reset = await api.patch("/v1/settings", {
      headers: bearer(admin),
      data: { server: { min_interval: null } },
    })
    expect(reset.ok(), await reset.text()).toBe(true)
  } finally {
    await api.dispose()
  }
})

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
  Settings: "table.settings tr[data-key]",
}
async function openTab(page: Page, tab: string) {
  await page.getByRole("link", { name: tab }).click()
  await expect(page).toHaveURL(new RegExp(`/${tab.toLowerCase()}$`))
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
    "Settings",
  ])
  const machine = page.locator('table.agents tbody[data-machine="smoke"]')
  await expect(machine.locator("tr.group")).toHaveText("smoke")
  const agent = machine.locator('tr[data-agent="smoke:agent"]')
  await expect(agent.locator("td.desc")).toHaveText("made by the smoke test")
  await expect(agent.getByRole("button", { name: "Unregister" })).toBeVisible()
  // How long ago the page loaded, counting up every second.
  const updated = page.locator(".toolbar app-updated")
  await expect(updated).toHaveText(/^Updated \d+s ago\.$/)
  await expect(updated).toHaveText(/^Updated [1-9]\d*s ago\.$/)
  await page.getByRole("link", { name: "Hosts" }).click()
  await expect(page.locator("#frame p.muted")).toHaveText(
    /connects from\. Updated \d+s ago\.$/,
  )
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

for (const width of [1280, 1024]) {
  test(`layout: every page fits ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await signIn(page, admin)
    const row = page.locator(`table.agents tr[data-agent="${LONG.agent}"]`)
    await expect(row.locator("td.folder")).toHaveText(LONG.directory)
    await expect(row.locator("td.session")).toHaveText(LONG.session)
    expect(await overflow(page), "Agents").toEqual({ frame: 0, page: 0 })
    await page.getByRole("link", { name: "Hosts" }).click()
    const host = page.locator(`table.hosts tr[data-host="${LONG.host}"]`)
    await expect(host.locator("td.folder")).toHaveText(LONG.directory)
    expect(await overflow(page), "Hosts").toEqual({ frame: 0, page: 0 })
    await openTab(page, "Settings")
    expect(await overflow(page), "Settings").toEqual({ frame: 0, page: 0 })
  })
}

test("layout: wrapped action buttons have space between their lines", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await signIn(page, admin)
  const buttons = page.locator(
    `table.agents tr[data-agent="${LONG.agent}"] td.actions button`,
  )
  await expect(buttons).toHaveCount(3)
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
      Object.entries(boxes).map(([k, r]) => [k, Math.abs(mid(r) - center)]),
    )
  })
  for (const [item, offset] of Object.entries(offsets))
    expect(offset, item).toBeLessThanOrEqual(1)
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
    ".toolbar .muted",
    "header .server",
    "header .who",
  ])
  await openTab(page, "Hosts")
  const hosts = await sizes([
    "#frame .muted",
    "table.hosts tr.group th",
    "table.hosts td.folder",
  ])
  for (const [item, size] of Object.entries({ ...agents, ...hosts }))
    expect(size, item).toBe("15px")
})

test("layout: a page's first item has no top margin", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of ["Hosts", "Agents", "Settings"]) {
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
    page.locator("h1, h2, h3, thead th, button").evaluateAll((all) =>
      all.map((e) => {
        // Code and the header's server ID are data: they count as one
        // capitalized word.
        const copy = e.cloneNode(true) as Element
        for (const data of copy.querySelectorAll("code, small"))
          data.replaceWith("Data")
        return (copy.textContent ?? "").trim()
      }),
    )
  await page.goto("/")
  await expect(page.getByLabel("Token")).toBeVisible()
  const seen = [...(await headings())]
  await signIn(page, admin)
  for (const tab of ["Hosts", "Agents", "Settings"]) {
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
  for (const tab of ["Hosts", "Agents", "Settings"]) {
    await openTab(page, tab)
    await expect(page).toHaveTitle("Autocode")
  }
})

test("no page writes a hyphen where a dash belongs", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of ["Hosts", "Agents", "Settings"]) {
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

// Room above every table: 0.8rem from what comes before it (the owner's
// choice, twice the old 0.4rem).
test("layout: tables have room above them", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of ["Hosts", "Agents", "Settings"]) {
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
    for (const gap of gaps) expect(gap, tab).toBeCloseTo(12.8, 0)
  }
})

// Table cells: 6 px above and below, 10 px left and right (the owner's
// choice, 2 px more than before).
test("layout: table cells have their padding", async ({ page }) => {
  await signIn(page, admin)
  for (const tab of ["Hosts", "Agents", "Settings"]) {
    await openTab(page, tab)
    const paddings = await page
      .locator("#frame th, #frame td")
      .evaluateAll((cells) => [
        ...new Set(cells.map((c) => getComputedStyle(c).padding)),
      ])
    expect(paddings, tab).toEqual(["6px 10px"])
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
  for (const tab of ["Hosts", "Agents", "Settings"]) {
    await openTab(page, tab)
    expect(await padding(), tab).toBe("20px")
  }
})

test("layout: the Agents toolbar has Refresh at the left, the filter at the right", async ({
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
  expect(refresh.left - toolbar.left, "Refresh").toBeLessThanOrEqual(1)
  expect(toolbar.right - field.right, "the field").toBeLessThanOrEqual(1)
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
  for (const tab of ["Hosts", "Agents", "Settings"]) {
    await openTab(page, tab)
    sizes[tab] = await page
      .locator("button:not(.theme)")
      .evaluateAll((all) => [
        ...new Set(all.map((b) => getComputedStyle(b).fontSize)),
      ])
  }
  expect(sizes).toEqual({
    Hosts: ["15px"],
    Agents: ["15px"],
    Settings: ["15px"],
  })
})

// Settings: Save and Reset sit as close as the Agents row buttons and are as
// tall as the edit field; the Value column is 1.5 times its old 304 px at
// 1280 px.
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
  expect((await box(value)).width, "the Value column").toBeCloseTo(456, 0)
})

// The header: the title "Autocode" is 17 px; the "admin" badge has no border.
test("layout: the header's title is 17 px, the admin badge has no border", async ({
  page,
}) => {
  await signIn(page, admin)
  await expect(page.locator("header .who")).toHaveText("admin")
  const style = await page.evaluate(() => {
    const who = getComputedStyle(document.querySelector("header .who")!)
    return {
      title: getComputedStyle(document.querySelector("header h1")!).fontSize,
      border: who.borderTopStyle,
    }
  })
  expect(style).toEqual({ title: "17px", border: "none" })
})

// Checkboxes take the favicon's pink-red, on the sign-in form and in Settings.
test("checkboxes have the favicon's tint", async ({ page }) => {
  const tint = "rgb(232, 67, 110)"
  await page.goto("/")
  const stay = page.locator(".sign-in input[type=checkbox]")
  await expect(stay).toHaveCSS("accent-color", tint)
  await signIn(page, admin)
  await page.getByRole("link", { name: "Settings" }).click()
  const box = page.locator("table.settings input[type=checkbox]").first()
  await expect(box).toHaveCSS("accent-color", tint)
})

// Dropdowns draw their own arrow, the same on every browser, with its right
// end 9 px from the border: 5 px further in than the native one (about 4 px in
// Chromium), which sat too far right on the Mac.
test("dropdowns draw their arrow 9 px from the right border", async ({
  page,
}) => {
  await signIn(page, admin)
  await page.getByRole("link", { name: "Settings" }).click()
  const select = page.locator(
    'table.settings tr[data-key="question_mode"] select',
  )
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
  })
})
