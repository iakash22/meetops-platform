/**
 * Outbound auth mail port. Will be backed by @meetops/notifications sendTemplate /
 * startEmailWorker once PR #11 merges. Implementations must never log tokens.
 */
export interface AuthMailer {
  sendEmailVerification(to: string, token: string): Promise<void>;
  sendAccountExists(to: string): Promise<void>;
  sendPasswordReset(to: string, token: string): Promise<void>;
  sendInvitation(to: string, input: { organizationName: string; token: string }): Promise<void>;
}

export class NoopAuthMailer implements AuthMailer {
  async sendEmailVerification() {}
  async sendAccountExists() {}
  async sendPasswordReset() {}
  async sendInvitation() {}
}

/** Test double that records calls in memory. */
export class RecordingAuthMailer implements AuthMailer {
  readonly sent: { kind: string; to: string; token?: string }[] = [];
  async sendEmailVerification(to: string, token: string) {
    this.sent.push({ kind: 'verify', to, token });
  }
  async sendAccountExists(to: string) {
    this.sent.push({ kind: 'exists', to });
  }
  async sendPasswordReset(to: string, token: string) {
    this.sent.push({ kind: 'reset', to, token });
  }
  async sendInvitation(to: string, input: { organizationName: string; token: string }) {
    this.sent.push({ kind: 'invite', to, token: input.token });
  }
}
