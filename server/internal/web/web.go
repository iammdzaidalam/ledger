package web

import (
	"embed"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strings"
)

//go:embed index.html app.css app.js demo.js
var files embed.FS

var (
	styleTag  = regexp.MustCompile(`<link rel="stylesheet" href="([\w.-]+)">`)
	scriptTag = regexp.MustCompile(`<script src="([\w.-]+)"></script>`)
)

var index = inline()

func inline() []byte {
	page, err := files.ReadFile("index.html")
	if err != nil {
		panic(err)
	}
	page = styleTag.ReplaceAllFunc(page, func(m []byte) []byte {
		body, err := files.ReadFile(string(styleTag.FindSubmatch(m)[1]))
		if err != nil {
			return m
		}
		return []byte("<style>\n" + string(body) + "</style>")
	})
	page = scriptTag.ReplaceAllFunc(page, func(m []byte) []byte {
		body, err := files.ReadFile(string(scriptTag.FindSubmatch(m)[1]))
		if err != nil {
			return m
		}
		return []byte("<script>\n" + string(body) + "</script>")
	})
	return page
}

func contentType(name string) string {
	switch path.Ext(name) {
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		var body []byte
		switch name {
		case "", "index.html":
			name = "index.html"
			body = index
		default:
			b, err := files.ReadFile(name)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			body = b
		}
		w.Header().Set("Content-Type", contentType(name))
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(body)
	})
}
