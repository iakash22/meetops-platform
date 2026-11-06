-- Google OIDC subject. Nullable: password-only accounts have no Google identity.
-- PostgreSQL unique indexes allow many NULLs, so existing users are unchanged.
ALTER TABLE "users" ADD COLUMN "google_sub" TEXT;

CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");
