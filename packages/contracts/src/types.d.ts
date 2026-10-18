declare module "semver" {
  export function valid(version: string | null | undefined): string | null;
  export function satisfies(version: string, range: string): boolean;
  export function validRange(range: string | null | undefined): string | null;
  const semver: {
    valid: typeof valid;
    satisfies: typeof satisfies;
    validRange: typeof validRange;
  };
  export default semver;
}
