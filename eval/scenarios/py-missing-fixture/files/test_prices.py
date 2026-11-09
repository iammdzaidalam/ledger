import unittest

from prices import cheapest, load


class PricesTest(unittest.TestCase):
    def test_cheapest(self):
        self.assertEqual(cheapest({"tea": 3, "coffee": 4}), "tea")

    def test_load(self):
        prices = load("fixtures/prices.json")
        self.assertIn("tea", prices)


if __name__ == "__main__":
    unittest.main()
