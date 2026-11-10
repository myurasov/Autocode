/*
 * Markdown files imported as text (`with { type: "text" }`): the agent
 * guide's source, embedded in the plugin's bundle by Bun.
 */
declare module "*.md" {
  const text: string
  export default text
}
