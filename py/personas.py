#!/usr/bin/env python3
"""The personas an env file declares, read the one way every command reads them.

Usage: personas.py names <file>
       personas.py list <file> [--json]
       personas.py import <source> <target> [--prefix <P>]

A key is `<prefix><NAME>_<FIELD>` and both halves may hold underscores (`tb_non_verifie`,
`FCM_TOKEN_IOS`), so no regex can split it. A persona is declared by its `_EMAIL` key; every other
key belongs to the longest declared name it starts with; a key that belongs to none (an id a project
kept next to its credentials) is nobody's and an import leaves it behind. An `_EMAIL` key under a
declared name, with no `_PASSWORD` of its own, is that persona's field (`RESIDENT_BACKUP_EMAIL`),
not a persona of its own.

Nothing here prints a value that reads as a credential: `list` says a secret is there, and `import`
names the keys it skipped, never their values. Exit: 0, or 2 on an unreadable file.
"""

import json
import os
import re
import sys

PREFIX = "VYSU_PERSONA_"
SECRET = re.compile(r"(PASSWORD|TOKEN|SECRET|KEY)$")


def read_pairs(path, prefix):
    """{KEY without the prefix, upper-cased: raw value} for the keys that carry the prefix."""
    pairs = {}
    for raw in open(path):
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        if key.upper().startswith(prefix.upper()) and len(key) > len(prefix):
            pairs[key[len(prefix):].upper()] = value
    return pairs


def names(pairs):
    declared = {k[: -len("_EMAIL")] for k in pairs if k.endswith("_EMAIL") and len(k) > len("_EMAIL")}

    def is_a_field(name):
        if name + "_PASSWORD" in pairs:
            return False
        return any(name.startswith(other + "_") for other in declared if other != name)

    return sorted(n for n in declared if not is_a_field(n))


def split(pairs):
    """({NAME: {FIELD: raw value}}, [keys that belong to no persona])"""
    longest_first = sorted(names(pairs), key=len, reverse=True)
    people, orphans = {}, []
    for key, value in pairs.items():
        owner = next((n for n in longest_first if key.startswith(n + "_")), None)
        if owner is None:
            orphans.append(key)
            continue
        people.setdefault(owner, {})[key[len(owner) + 1:]] = value
    return people, sorted(orphans)


def cmd_names(path):
    for name in names(read_pairs(path, PREFIX)):
        print(name.lower())


def cmd_list(path, as_json):
    people, _ = split(read_pairs(path, PREFIX))
    listed = []
    for name in sorted(people):
        person = {"name": name.lower()}
        for field, value in people[name].items():
            # A secret is declared, never carried: what a consumer needs to know is that it is there.
            person[field.lower()] = True if SECRET.search(field) else value.strip("\"'")
        listed.append(person)
    if as_json:
        print(json.dumps(listed, ensure_ascii=False, indent=1))
        return
    for person in listed:
        keys = " ".join(k for k in sorted(person) if k not in ("name", "email"))
        print("%s: %s%s" % (person["name"], person.get("email", "(no e-mail)"), " · " + keys if keys else ""))


def cmd_import(source, target, prefix):
    people, orphans = split(read_pairs(source, prefix))
    kept = {}
    if os.path.exists(target):
        for raw in open(target):
            if "=" in raw and not raw.lstrip().startswith("#"):
                kept[raw.split("=", 1)[0].strip()] = raw.rstrip("\n")
    added = 0
    for name, fields in people.items():
        for field, value in fields.items():
            key = PREFIX + name + "_" + field
            kept[key] = key + "=" + value
            added += 1
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    # Created 600, not chmod-ed after the fact: the credentials are never readable by anyone else.
    fd = os.open(target + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        for key in sorted(kept):
            out.write(kept[key] + "\n")
    os.replace(target + ".tmp", target)
    os.chmod(target, 0o600)
    print("persona import: %d key(s), %d persona(s) from %s → %s (mode 600)" % (added, len(people), source, target))
    print("personas: " + " ".join(sorted(n.lower() for n in people)))
    if orphans:
        print("skipped, no persona of theirs: " + " ".join(prefix + k for k in orphans))


def main(argv):
    try:
        if len(argv) >= 2 and argv[0] == "names":
            cmd_names(argv[1])
        elif len(argv) >= 2 and argv[0] == "list":
            cmd_list(argv[1], "--json" in argv[2:])
        elif len(argv) >= 3 and argv[0] == "import":
            prefix = argv[argv.index("--prefix") + 1] if "--prefix" in argv[3:] else ""
            cmd_import(argv[1], argv[2], prefix)
        else:
            print(__doc__.split("\n\n")[1], file=sys.stderr)
            return 2
    except OSError as err:
        print("personas.py: %s" % err, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
