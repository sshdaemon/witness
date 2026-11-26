/** A failure a tool reports to the model: a stable code, what happened, and what to do next. */
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}
