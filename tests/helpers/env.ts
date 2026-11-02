/*
 * What a suite's runner container is told by its Compose file.
 */

export const nodes = (process.env.NODES ?? "").split(",").filter(Boolean)
export const autocodeUrl = process.env.AUTOCODE_URL ?? "http://server:4848"
export const fakeModelUrl =
  process.env.FAKE_MODEL_URL ?? "http://fake-model:9000"
export const probeUrl = process.env.PROBE_URL ?? ""
export const opencodePassword = process.env.OPENCODE_PASSWORD ?? ""
export const adminToken = process.env.AUTOCODE_ADMIN_TOKEN ?? ""
export const consumerToken = process.env.AUTOCODE_CONSUMER_TOKEN ?? ""

export function opencodeUrl(node: string): string {
  return `http://${node}:4096`
}
