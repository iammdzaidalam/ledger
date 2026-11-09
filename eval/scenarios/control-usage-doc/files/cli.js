const i = process.argv.indexOf("--name");
console.log(`hello ${i > -1 ? process.argv[i + 1] : "world"}`);
