/** Fork-PR gate probe (core-8fz): deliberately unsafe so the LLM gate fails. */
export function riskyEval(userInput: string): unknown {
   
  return eval(userInput);
}
