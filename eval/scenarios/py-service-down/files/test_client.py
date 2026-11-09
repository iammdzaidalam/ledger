import unittest

from client import ping


class PingTest(unittest.TestCase):
    def test_ping(self):
        self.assertEqual(ping(), b"PONG")


if __name__ == "__main__":
    unittest.main()
