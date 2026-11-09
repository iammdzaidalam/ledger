import json


def load(path):
    with open(path) as f:
        return json.load(f)


def cheapest(prices):
    return min(prices, key=prices.get)
