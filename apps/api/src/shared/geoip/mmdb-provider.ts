import { readFileSync } from 'node:fs';
import { Reader, type CityResponse } from 'maxmind';
import type { GeoIpProvider, GeoLocation } from './provider.js';

/**
 * DB-IP "IP to City Lite" (CC BY 4.0, https://db-ip.com) or GeoLite2-City mmdb, read into memory and queried locally
 * with the `maxmind` package. Only names and the ISO country code are read: never location/latitude/longitude,
 * accuracy radius or postal code.
 */
export class MmdbGeoIpProvider implements GeoIpProvider {
  readonly name: string;
  private reader: Reader<CityResponse>;

  constructor(
    private readonly path: string,
    name = 'dbip-city-lite',
  ) {
    this.name = name;
    this.reader = MmdbGeoIpProvider.open(path);
  }

  /** Opens and sanity-checks an mmdb file; throws when the file is not a readable mmdb. */
  static open(path: string): Reader<CityResponse> {
    const reader = new Reader<CityResponse>(readFileSync(path));
    if (!reader.metadata?.databaseType) throw new Error('mmdb has no metadata');
    return reader;
  }

  /** Re-read the file after the updater atomically swapped it (PR 6). Keeps the old reader if the new file is bad. */
  reload(): boolean {
    try {
      this.reader = MmdbGeoIpProvider.open(this.path);
      return true;
    } catch {
      return false;
    }
  }

  lookupPublic(ip: string): GeoLocation | null {
    const r = this.reader.get(ip);
    if (!r) return null;
    return {
      city: r.city?.names?.en ?? null,
      region: r.subdivisions?.[0]?.names?.en ?? null,
      country: r.country?.names?.en ?? null,
      countryCode: r.country?.iso_code ?? null,
    };
  }
}
