/** True when running under Bun, false under Node. */
export const isBun: boolean =
  typeof process !== 'undefined' && typeof process.versions?.bun === 'string'
