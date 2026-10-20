"""Drop the entire NuBuah database (same as the mongosh one-liner, no mongosh needed).

Usage (from the backend folder, venv active):
    python ../scripts/reset_db.py

Asks for confirmation, then drops DB_NAME from MONGO_URL (both read from backend/.env).
Everything is deleted — stores, menu, orders, users, customers. Make sure you have a
backup if you might want the data back.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from dotenv import load_dotenv  # noqa: E402
from pymongo import MongoClient  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / "backend" / ".env")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "nubuah")

if input(f"Ketik YES untuk menghapus SELURUH database '{DB_NAME}' di {MONGO_URL}: ").strip() != "YES":
    print("Dibatalkan.")
    sys.exit(0)

MongoClient(MONGO_URL).drop_database(DB_NAME)
print(f"Database '{DB_NAME}' dihapus. Jalankan seed: python ../scripts/seed_demo.py")
