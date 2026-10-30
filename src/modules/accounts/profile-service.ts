import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import { inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { totalXp } from '../goals/ledger-repository.ts';
import type { Principal } from '../sessions/guard.ts';
import { emailField, withAccountKey } from './account-mail.ts';
import { findProfile, updateProfile, type Profile, type ProfileChanges } from './repository.ts';
import type { AccountUpdate } from './schemas.ts';

/** The account resource (`GET`/`PATCH /me`, contract `Account`; R-PRIV-01, A-01, ADR-0008). */

export interface ProfileServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly dataKeys: DataKeys;
}

export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly nickname: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly weekStart: string;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
  /** The XP ledger's total (R-XP-04); the level follows from it. */
  readonly xpTotal: number;
  readonly version: number;
}

export type UpdateProfileResult =
  | { readonly outcome: 'updated'; readonly account: AccountView }
  | { readonly outcome: 'version_conflict'; readonly currentVersion: number };

export interface ProfileService {
  get(principal: Principal): Promise<AccountView>;
  /** Changes the settings if `expectedVersion` is still current (otherwise: the current version, for the 409). */
  update(principal: Principal, expectedVersion: number, update: AccountUpdate): Promise<UpdateProfileResult>;
}

/** The account was removed while its session was still valid: nothing to show. */
export class AccountGoneError extends Error {
  override readonly name = 'AccountGoneError';
}

const nicknameField = (userId: string) => ({ userId, recordId: userId, field: 'nickname_enc' });

export function createProfileService(deps: ProfileServiceDependencies): ProfileService {
  const view = async (tx: Transaction, profile: Profile, dataKey: Uint8Array): Promise<AccountView> => ({
    id: profile.id,
    email: decryptText(dataKey, emailField(profile.id), profile.emailEnc),
    nickname:
      profile.nicknameEnc === null ? null : decryptText(dataKey, nicknameField(profile.id), profile.nicknameEnc),
    timezone: profile.timezone,
    locale: profile.locale,
    weekStart: profile.weekStart,
    emailVerified: profile.emailVerifiedAt !== null,
    createdAt: profile.createdAt,
    xpTotal: await totalXp(tx, profile.id),
    version: profile.version,
  });

  const load = async (tx: Transaction, userId: string): Promise<Profile> => {
    const profile = await findProfile(tx, userId);
    if (profile === undefined) throw new AccountGoneError();
    return profile;
  };

  return {
    async get(principal) {
      return inTransaction(deps.db, async (tx) => {
        const profile = await load(tx, principal.userId);
        return withAccountKey(tx, deps.dataKeys, principal.userId, (dataKey) => view(tx, profile, dataKey));
      });
    },

    async update(principal, expectedVersion, update) {
      const now = deps.clock.now();
      return inTransaction(deps.db, async (tx) =>
        withAccountKey(tx, deps.dataKeys, principal.userId, async (dataKey): Promise<UpdateProfileResult> => {
          const changes: ProfileChanges = {
            ...(update.nickname === undefined
              ? {}
              : {
                  nicknameEnc:
                    update.nickname === null
                      ? null
                      : encryptText(dataKey, nicknameField(principal.userId), update.nickname),
                }),
            ...(update.timezone === undefined ? {} : { timezone: update.timezone }),
            ...(update.locale === undefined ? {} : { locale: update.locale }),
            ...(update.week_start === undefined ? {} : { weekStart: update.week_start }),
          };
          const updated = await updateProfile(tx, principal.userId, expectedVersion, changes, now);
          if (updated === undefined) {
            return { outcome: 'version_conflict', currentVersion: (await load(tx, principal.userId)).version };
          }
          return { outcome: 'updated', account: await view(tx, updated, dataKey) };
        }),
      );
    },
  };
}
