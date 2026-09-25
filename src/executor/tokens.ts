import { Tiktoken } from 'js-tiktoken'
import cl100k_base from 'js-tiktoken/ranks/cl100k_base'

// The rank table is a static import and loads with this module; what is
// deferred is turning it into the encoder's lookup maps, which is the
// expensive half and is done once, on first use.
let encoder: Tiktoken | undefined

/** Tokens an agent would spend reading `text`, under cl100k_base. */
export function countTokens(text: string): number {
  encoder ??= new Tiktoken(cl100k_base)
  return encoder.encode(text).length
}
