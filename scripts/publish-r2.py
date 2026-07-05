#!/usr/bin/env python3
"""Publish current.html to the R2 'ledger' bucket (the Cloudflare Worker's live
surface). Called by ledger-cron.sh after each scheduled fire so R2 stays in sync
with GitHub Pages. Reads creds from ~/.project_ledger/config.toml."""
import os, re, sys
HOME = os.path.expanduser("~")
CURRENT = os.path.join(HOME, "spock-data", "project_ledger", "current.html")
CONFIG = os.path.join(HOME, ".project_ledger", "config.toml")

txt = open(CONFIG).read()
def g(k):
    m = re.search(rf'{k}\s*=\s*"([^"]+)"', txt); return m.group(1) if m else None
acc, ak, sk, bucket = g("account_id"), g("r2_access_key"), g("r2_secret_key"), (g("r2_bucket") or "ledger")

import boto3
from botocore.config import Config
s3 = boto3.client("s3", endpoint_url=f"https://{acc}.r2.cloudflarestorage.com",
                  aws_access_key_id=ak, aws_secret_access_key=sk,
                  config=Config(signature_version="s3v4", region_name="auto"))
body = open(CURRENT, "rb").read()
s3.put_object(Bucket=bucket, Key="current.html", Body=body,
              ContentType="text/html; charset=utf-8", CacheControl="no-cache, max-age=0")
print(f"  ✓ R2 current.html updated ({len(body):,} bytes)")
