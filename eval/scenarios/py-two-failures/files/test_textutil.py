import unittest

from textutil import api_token, title


class TextTest(unittest.TestCase):
    def test_title(self):
        self.assertEqual(title("hello world"), "Hello World")

    def test_token(self):
        self.assertTrue(api_token().startswith("tk_"))


if __name__ == "__main__":
    unittest.main()
