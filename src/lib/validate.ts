import { AUTO, BUILTIN_VARIABLES, type Field, type Role, type Variable } from "./types";

export interface TemplateIssue {
  level: "error" | "warning";
  message: string;
  fieldId?: string;
  /** Machine hint the editor uses to offer a one-click fix. */
  fix?: "firm_signature" | "add_signature_page";
}

/**
 * The single definition of "this agreement is safe to send". The editor shows these as a
 * live checklist; the server enforces the same list on publish and again on send.
 */
export function templateIssues(
  t: { fields: Field[]; roles: Role[]; variables: Variable[]; pageCount: number },
  hasFirmSignature: boolean,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const roleKeys = new Set(t.roles.map((r) => r.key));
  const variableKeys = new Set([...BUILTIN_VARIABLES.map((v) => v.key), ...t.variables.map((v) => v.key)]);

  if (t.roles.length === 0) issues.push({ level: "error", message: "Add at least one signer." });

  for (const role of t.roles) {
    const mine = t.fields.filter((f) => f.assignee === role.key);
    if (!mine.some((f) => f.type === "signature")) {
      issues.push({
        level: "error",
        message: `${role.label} has no signature field. Place one on the document, or add a signature page.`,
        fix: "add_signature_page",
      });
    }
  }

  let firmFlagged = false;
  for (const f of t.fields) {
    if (f.page >= t.pageCount) issues.push({ level: "error", message: "A field sits on a page that no longer exists.", fieldId: f.id });
    if (f.assignee !== AUTO && !roleKeys.has(f.assignee)) {
      issues.push({ level: "error", message: "A field is assigned to a signer that was removed.", fieldId: f.id });
    }
    if (f.assignee === AUTO) {
      if ((f.type === "signature" || f.type === "initials" || f.type === "name") && !hasFirmSignature && !firmFlagged) {
        firmFlagged = true;
        issues.push({
          level: "error",
          message: "This agreement includes your firm's signature, but no firm signature is set up yet.",
          fieldId: f.id,
          fix: "firm_signature",
        });
      }
      if (f.type === "text") {
        if (!f.variable) issues.push({ level: "error", message: "Choose what fills this automatic field.", fieldId: f.id });
        else if (!variableKeys.has(f.variable)) {
          issues.push({ level: "error", message: `The variable "${f.variable}" is not defined.`, fieldId: f.id });
        } else if ((f.variable === "firm_signer_name" || f.variable === "firm_signer_title") && !hasFirmSignature && !firmFlagged) {
          firmFlagged = true;
          issues.push({
            level: "error",
            message: "This agreement includes your firm signer's details, but no firm signature is set up yet.",
            fieldId: f.id,
            fix: "firm_signature",
          });
        }
      }
    }
  }

  const unsure = t.fields.filter((f) => f.source === "detected" && (f.confidence ?? 1) < 0.6).length;
  if (unsure > 0) {
    issues.push({
      level: "warning",
      message: `${unsure} detected ${unsure === 1 ? "field is a best guess" : "fields are best guesses"}. Check the ones marked "Check".`,
    });
  }
  return issues;
}

/** Custom variables a person must supply when opening a file with this template. */
export function requiredInputs(t: { fields: Field[]; variables: Variable[] }): Variable[] {
  const used = new Set(t.fields.filter((f) => f.assignee === AUTO && f.variable).map((f) => f.variable!));
  return t.variables.filter((v) => used.has(v.key));
}
