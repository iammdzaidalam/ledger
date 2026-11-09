import os


def title(s):
    return s.upper()


def api_token():
    return os.environ["TEXTUTIL_TOKEN"]
