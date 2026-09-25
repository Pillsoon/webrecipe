import type { CheckName, VerificationContract } from '../local.js'
import type { Intent } from '../types.js'

/**
 * What a learned task must prove, decided from the plan's own capabilities.
 *
 * Deterministic on purpose, and deliberately unaware of any result. A contract
 * chosen from what happened to pass would be a test whose passing grade was
 * written after the test, which is the one thing a verification model cannot
 * afford. Nothing here consults the benchmark's oracles either: the oracle
 * grades this system from outside, and a contract derived from it would make
 * the engine its own examiner.
 *
 * It stays this small until a check exists to justify more. A requirement for
 * a check nobody has implemented only produces plans that can never verify.
 *
 * A search asks for both query checks because neither is enough alone: the
 * first passes a site that honours the query and answers with the wrong
 * records, and the second passes a site whose words happen to line up.
 *
 * Pagination is required exactly when the plan templates `page`, which is not
 * the same as the site having pages. Templating it is an authoring act: it
 * makes `run --page N` a supported operation, and what a task supports is what
 * it has to be right about. A task whose promise is one page does not template
 * page, and is not asked to prove anything about it.
 */
export function buildContract(intent: Intent, templated: Set<string>): VerificationContract {
  const required: CheckName[] = ['non_empty', 'required_fields']
  if (intent === 'search' && templated.has('query')) required.push('query_honored', 'lexical_query_consistency')
  if (templated.has('page')) required.push('pagination_honored')
  return { required }
}
