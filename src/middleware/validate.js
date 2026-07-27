// Validates req.body against a zod schema. On failure returns 400 with the
// first error message; on success replaces req.body with the parsed data.
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const msg = result.error.issues?.[0]?.message || "Invalid input";
      return res.status(400).json({ error: msg });
    }
    req.body = result.data;
    next();
  };
}
