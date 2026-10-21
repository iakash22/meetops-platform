import type { UserRepository } from '../../users/domain/user.repository.js';
import { normalizeEmail, toPublicUser, type PublicUser } from '../../users/domain/user.js';
import type { Clock, IdGenerator } from '../../../shared/ports.js';
import type { PasswordHasher, TokenService } from '../domain/ports.js';
import { isSessionActive, type Session, type SessionRepository } from '../domain/session.js';
import { InvalidCredentialsError, UnauthenticatedError } from '../domain/errors.js';
import { DuplicateEmailError } from '../../users/domain/errors.js';

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  clock: Clock;
  ids: IdGenerator;
  sessionTtlMs: number;
}

export interface SessionResult {
  user: PublicUser;
  session: Session;
  /** Raw token, returned once for the cookie. Never log it. */
  token: string;
}

export class AuthService {
  constructor(private readonly d: AuthServiceDeps) {}

  async signup(input: { email: string; password: string; name?: string | undefined }): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    if (await this.d.users.findByEmail(email)) throw new DuplicateEmailError();
    const now = this.d.clock.now();
    const user = await this.d.users.create({
      id: this.d.ids.next(),
      email,
      name: input.name ?? null,
      passwordHash: await this.d.hasher.hash(input.password),
      createdAt: now,
      updatedAt: now
    });
    return this.issueSession(user.id, toPublicUser(user));
  }

  async login(input: { email: string; password: string }): Promise<SessionResult> {
    const user = await this.d.users.findByEmail(normalizeEmail(input.email));
    if (!user) {
      // Equalize timing a little for unknown emails.
      await this.d.hasher.hash(input.password);
      throw new InvalidCredentialsError();
    }
    if (!(await this.d.hasher.verify(user.passwordHash, input.password))) throw new InvalidCredentialsError();
    return this.issueSession(user.id, toPublicUser(user));
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const session = await this.d.sessions.findByTokenHash(this.d.tokens.hash(token));
    if (session && session.revokedAt === null) await this.d.sessions.revoke(session.id, this.d.clock.now());
  }

  /** Resolve the current session from a raw token or throw UnauthenticatedError. */
  async authenticate(token: string | undefined): Promise<{ user: PublicUser; session: Session }> {
    if (!token) throw new UnauthenticatedError();
    const session = await this.d.sessions.findByTokenHash(this.d.tokens.hash(token));
    if (!session || !isSessionActive(session, this.d.clock.now())) throw new UnauthenticatedError();
    const user = await this.d.users.findById(session.userId);
    if (!user) throw new UnauthenticatedError();
    return { user: toPublicUser(user), session };
  }

  private async issueSession(userId: string, user: PublicUser): Promise<SessionResult> {
    const token = this.d.tokens.generate();
    const now = this.d.clock.now();
    const session = await this.d.sessions.create({
      id: this.d.ids.next(),
      userId,
      tokenHash: this.d.tokens.hash(token),
      activeOrganizationId: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.d.sessionTtlMs),
      revokedAt: null
    });
    return { user, session, token };
  }
}
