/**
 * Temporary probe file for the fork-PR LLM split verification (core-8fz).
 * Safe to delete after the test PR is closed.
 */
export function riskyEval(userInput: string): unknown {
  // Deliberately unsafe so the adversarial review has something to flag.
   
  return eval(userInput);
}
