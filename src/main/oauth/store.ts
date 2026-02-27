import type { Database } from 'sql.js';
import type { OAuthProfileRecord, OAuthProviderId } from './types';

const safeParseObject = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // no-op
  }
  return {};
};

const safeParseStringArray = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // no-op
  }
  return [];
};

type OAuthRow = [
  profile_id: string,
  provider_id: string,
  access_token: string,
  refresh_token: string,
  expires_at_ms: number,
  project_id: string | null,
  email: string | null,
  scopes_json: string,
  meta_json: string,
  created_at: number,
  updated_at: number,
];

export class OAuthStore {
  private db: Database;
  private save: () => void;

  constructor(db: Database, save: () => void) {
    this.db = db;
    this.save = save;
  }

  getProfile(providerId: OAuthProviderId): OAuthProfileRecord | null {
    const result = this.db.exec(
      `
      SELECT profile_id, provider_id, access_token, refresh_token, expires_at_ms, project_id, email,
             scopes_json, meta_json, created_at, updated_at
      FROM oauth_profiles
      WHERE provider_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [providerId]
    );
    const row = result[0]?.values?.[0] as OAuthRow | undefined;
    if (!row) {
      return null;
    }
    return {
      profileId: row[0],
      providerId: row[1] as OAuthProviderId,
      accessToken: row[2],
      refreshToken: row[3],
      expiresAtMs: Number(row[4]) || 0,
      projectId: row[5] || '',
      email: row[6] || undefined,
      scopes: safeParseStringArray(row[7] || '[]'),
      meta: safeParseObject(row[8] || '{}'),
      createdAt: Number(row[9]) || Date.now(),
      updatedAt: Number(row[10]) || Date.now(),
    };
  }

  upsertProfile(profile: Omit<OAuthProfileRecord, 'createdAt' | 'updatedAt'>): OAuthProfileRecord {
    const now = Date.now();
    const existing = this.getProfile(profile.providerId);
    const profileId = existing?.profileId || profile.profileId;
    const createdAt = existing?.createdAt || now;

    if (existing) {
      this.db.run(
        `
        UPDATE oauth_profiles
        SET profile_id = ?, access_token = ?, refresh_token = ?, expires_at_ms = ?,
            project_id = ?, email = ?, scopes_json = ?, meta_json = ?, updated_at = ?
        WHERE provider_id = ?
        `,
        [
          profileId,
          profile.accessToken,
          profile.refreshToken,
          Math.floor(profile.expiresAtMs),
          profile.projectId || null,
          profile.email || null,
          JSON.stringify(profile.scopes || []),
          JSON.stringify(profile.meta || {}),
          now,
          profile.providerId,
        ]
      );
    } else {
      this.db.run(
        `
        INSERT INTO oauth_profiles (
          profile_id, provider_id, access_token, refresh_token, expires_at_ms, project_id, email,
          scopes_json, meta_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          profileId,
          profile.providerId,
          profile.accessToken,
          profile.refreshToken,
          Math.floor(profile.expiresAtMs),
          profile.projectId || null,
          profile.email || null,
          JSON.stringify(profile.scopes || []),
          JSON.stringify(profile.meta || {}),
          createdAt,
          now,
        ]
      );
    }
    this.save();

    return {
      ...profile,
      profileId,
      createdAt,
      updatedAt: now,
    };
  }

  deleteProfile(providerId: OAuthProviderId): void {
    this.db.run('DELETE FROM oauth_profiles WHERE provider_id = ?', [providerId]);
    this.save();
  }
}
