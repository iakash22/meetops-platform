#!/usr/bin/env python3
"""
Generates test-city.mmdb, the fixed GeoIP fixture used by apps/api tests (ADR-014).

Provenance: written from scratch by this script with MaxMind's open-source writer `mmdb-writer` 0.2.7 (PyPI, MIT) and
netaddr. The data is FICTIONAL test data in the DB-IP/GeoLite2 City record shape (city/subdivisions/country names and
country.iso_code). It contains no DB-IP or MaxMind data and is not a real geolocation database.

Regenerate: python3 -m venv /tmp/v && /tmp/v/bin/pip install mmdb-writer==0.2.7 netaddr==1.3.0 && /tmp/v/bin/python generate-fixture.py
"""
from netaddr import IPSet
from mmdb_writer import MMDBWriter

def rec(city, region, country, cc):
    r = {"country": {"iso_code": cc, "names": {"en": country}}}
    if city is not None:
        r["city"] = {"names": {"en": city}}
    if region is not None:
        r["subdivisions"] = [{"names": {"en": region}}]
    return r

w = MMDBWriter(ip_version=6, ipv4_compatible=True, database_type="MeetOps-Test-City", languages=["en"],
               description="MeetOps ADR-014 test fixture (fictional data)")
w.insert_network(IPSet(["81.2.69.0/24"]), rec("London", "England", "United Kingdom", "GB"))
w.insert_network(IPSet(["89.160.20.0/24"]), rec("Linköping", "Östergötland County", "Sweden", "SE"))
w.insert_network(IPSet(["175.16.199.0/24"]), rec("Changchun", "Jilin Sheng", "China", "CN"))
w.insert_network(IPSet(["2.125.160.0/24"]), rec("St. John's", "Newfoundland and Labrador", "Canada", "CA"))
w.insert_network(IPSet(["2001:218::/32"]), rec(None, None, "Japan", "JP"))
# Hostile values: must be sanitised to safe text or dropped by the provider.
w.insert_network(IPSet(["1.128.0.0/16"]), rec("Evil\r\nBcc: x", "\u202eReversed", "Aus<b>tralia", "au"))
w.insert_network(IPSet(["5.6.7.0/24"]), rec("8.8.8.8", "2001:db8::1", "Nowhere", "ZZZ"))
w.to_db_file("test-city.mmdb")
