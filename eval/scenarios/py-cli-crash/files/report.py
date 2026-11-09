import csv

with open("sales.csv") as f:
    rows = list(csv.DictReader(f))

total = sum(float(r["amount"]) for r in rows)
print(f"rows: {len(rows)}")
print(f"average sale: {total / len(rows):.2f}")
