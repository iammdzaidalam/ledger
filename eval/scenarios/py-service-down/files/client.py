import socket


def ping(host="127.0.0.1", port=6553):
    with socket.create_connection((host, port), timeout=1) as s:
        s.sendall(b"PING\n")
        return s.recv(16).strip()
