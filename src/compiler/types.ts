import type { Recipe } from '../recipes/schema.js'
import type { Trace } from '../recorder/types.js'

/**
 * Why the compiler would not produce a recipe. A bare null said only that some
 * step said no, so every diagnosis of a refused site so far was a scratch
 * script re-running the compiler by hand with prints in it.
 */
export interface Refused {
  refused: string
}

export type CompileResult = Recipe | Refused

export function isRefused(result: CompileResult): result is Refused {
  return 'refused' in result
}

export interface Compiler {
  compile(trace: Trace): Promise<CompileResult>
}

/**
 * Equal counts that still do not match are a different diagnosis from a short
 * read, and saying "8 items, browser saw 8" for the first reads as agreement.
 */
export function equivalenceRefusal(recipeItems: number, browserItems: number): string {
  return recipeItems === browserItems
    ? `equivalence: recipe and browser both yield ${recipeItems} items, but they differ`
    : `equivalence: recipe yields ${recipeItems} items, browser saw ${browserItems}`
}
