// Password policy shared by the browser (live strength meter) and the Edge
// Functions (authoritative server-side enforcement). Pure TypeScript, no deps.

export interface PasswordRequirement {
  id: 'length' | 'uppercase' | 'number' | 'symbol';
  label: string;
  met: boolean;
}

export const STRENGTH_LABELS = ['Poor', 'Weak', 'Fair', 'Good', 'Strong', 'Super Strong'] as const;
export type StrengthLabel = (typeof STRENGTH_LABELS)[number];

export interface PasswordAssessment {
  requirements: PasswordRequirement[];
  /** true when every mandatory requirement is satisfied */
  valid: boolean;
  /** 0..5 index into STRENGTH_LABELS */
  score: number;
  label: StrengthLabel;
  warnings: string[];
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72; // bcrypt limit used by Supabase Auth

const COMMON_FRAGMENTS = [
  'password', 'passw0rd', 'qwerty', 'abc123', 'letmein', 'welcome', 'admin', 'iloveyou',
  'monkey', 'dragon', 'football', 'baseball', 'master', 'login', '123456', 'billstore', 'invportiq',
];

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function hasSequence(pw: string, run = 4): boolean {
  const lower = pw.toLowerCase();
  for (const seq of SEQUENCES) {
    for (let i = 0; i + run <= seq.length; i++) {
      const frag = seq.slice(i, i + run);
      if (lower.includes(frag) || lower.includes([...frag].reverse().join(''))) return true;
    }
  }
  return false;
}

export function assessPassword(password: string): PasswordAssessment {
  const pw = password ?? '';
  const requirements: PasswordRequirement[] = [
    { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: pw.length >= PASSWORD_MIN_LENGTH },
    { id: 'uppercase', label: 'At least one uppercase letter (A–Z)', met: /[A-Z]/.test(pw) },
    { id: 'number', label: 'At least one number (0–9)', met: /\d/.test(pw) },
    { id: 'symbol', label: 'At least one special symbol (!@#$…)', met: /[^A-Za-z0-9\s]/.test(pw) },
  ];
  const metCount = requirements.filter((r) => r.met).length;
  const valid = metCount === requirements.length && pw.length <= PASSWORD_MAX_LENGTH;

  const warnings: string[] = [];
  const lower = pw.toLowerCase();
  const common = COMMON_FRAGMENTS.some((f) => lower.includes(f));
  const sequence = hasSequence(pw);
  const repeated = /(.)\1{2,}/.test(pw);
  const uniqueRatio = pw.length ? new Set(pw).size / pw.length : 0;
  if (common) warnings.push('Avoid common words such as "password" or the store name.');
  if (sequence) warnings.push('Avoid predictable sequences like "1234" or "abcd".');
  if (repeated) warnings.push('Avoid repeating the same character.');
  if (pw.length > PASSWORD_MAX_LENGTH) warnings.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);

  let score: number;
  if (pw.length === 0 || metCount <= 1) {
    score = 0; // Poor
  } else if (!valid) {
    score = metCount === 2 ? 1 : 2; // Weak / Fair
  } else {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9\s]/].filter((r) => r.test(pw)).length;
    score = 3; // Good: all requirements met
    if (pw.length >= 12 && classes >= 4 && uniqueRatio >= 0.6) score = 4; // Strong
    if (pw.length >= 16 && classes >= 4 && uniqueRatio >= 0.6 && !common && !sequence && !repeated) score = 5; // Super Strong
    if (common || sequence || repeated) score = Math.max(3, score - 1);
  }

  return { requirements, valid, score, label: STRENGTH_LABELS[score], warnings };
}

/** Returns a human readable error when the password violates the policy, otherwise null. */
export function passwordPolicyError(password: string): string | null {
  const { requirements, valid } = assessPassword(password);
  if (valid) return null;
  if ((password ?? '').length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  const missing = requirements.filter((r) => !r.met).map((r) => r.label.charAt(0).toLowerCase() + r.label.slice(1));
  return `Password must include: ${missing.join(', ')}.`;
}
