declare module "js-yaml" {
  export function load(input: string, options?: Record<string, unknown>): unknown
  export function dump(input: unknown, options?: Record<string, unknown>): string
}
