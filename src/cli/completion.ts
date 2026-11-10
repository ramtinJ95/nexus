/**
 * The scripts `nexus completion` prints, made from the command registry, so a command or flag the CLI parses is one
 * the shell completes. Thread and project IDs come from `nexus threads --json` and `nexus projects --json`, which a
 * Node child runs with a short timeout, and a control plane that does not answer in time completes nothing.
 */
import { globalOptions, type Command } from "./kit.ts";

export const shells = ["zsh", "bash", "fish"] as const;
type Shell = (typeof shells)[number];
type Names = "thread" | "project";

/** How a command completes: its flags, the ones that take a value, and what its first argument names. */
interface Spec { flags: string[]; valued: string[]; first: Names | "" }

const flagsOf = (options: object) => Object.entries(options).map(([name, option]) => ({ flag: `--${name}`, valued: (option as { type: string }).type === "string" }));
const globals = flagsOf(globalOptions);

/** The registry as each shell's script reads it: every name, the first words, each group's subcommands, and each spec. */
function modelOf(commands: Readonly<Record<string, Command>>) {
  const names = Object.keys(commands);
  const tops = [...new Set(names.map((name) => name.split(" ")[0]!))];
  const groups = tops.map((top) => ({ top, subs: names.filter((name) => name.startsWith(`${top} `)).map((name) => name.slice(top.length + 1)) })).filter((g) => g.subs.length > 0);
  const specOf = (name: string | null): Spec => {
    const command = name === null ? undefined : commands[name]!;
    const flags = [...globals, ...name === null ? [{ flag: "--version", valued: false }] : flagsOf(command?.options ?? {})];
    return { flags: flags.map((f) => f.flag), valued: flags.filter((f) => f.valued).map((f) => f.flag), first: command?.thread === true ? "thread" : command?.project === true ? "project" : "" };
  };
  return { names, tops, groups, specOf };
}
type Model = ReturnType<typeof modelOf>;
/** Which flag's value names a thread or a project. */
const valueNames: Record<string, Names> = { "--thread": "thread", "--project": "project" };
const idTimeoutMs = 2000;

/**
 * Prints the IDs `nexus threads --json` or `nexus projects --json` lists, one per line, and nothing when the command
 * fails, prints no JSON or runs past the timeout. The arguments after the list's name are the line's --url and --socks. Written without single quotes, so every shell quotes it alike.
 */
const idsScript = `const { execFileSync } = require("node:child_process"); try { for (const row of JSON.parse(execFileSync("nexus", [process.argv[1], "--json", ...process.argv.slice(2)], { timeout: ${idTimeoutMs}, stdio: ["ignore", "pipe", "ignore"] }))) console.log(row.id); } catch {}`;

const words = (list: readonly string[]) => list.join(" ");

function bash({ names, tops, groups, specOf }: Model): string {
  const spec = (pattern: string, s: Spec) => `    ${pattern}) flags="${words(s.flags)}" valued="${words(s.valued)}" first=${s.first} ;;`;
  return `# nexus completion for bash, printed by \`nexus completion bash\`. Turn it on with: eval "$(nexus completion bash)"
_nexus_ids() { command node -e '${idsScript}' "$@" 2>/dev/null; }
# COMP_WORDS keeps a word's quotes as typed, and no URL or proxy holds a quote.
_nexus_unquoted() { printf '%s' "$1" | tr -d "\\"'"; }
_nexus_spec() {
  case "$1" in
${spec(`""`, specOf(null))}
${names.map((name) => spec(`"${name}"`, specOf(name))).join("\n")}
    *) return 1 ;;
  esac
}
_nexus_subs() {
  case "$1" in
${groups.map((g) => `    "${g.top}") echo "${words(g.subs)}" ;;`).join("\n")}
  esac
}
_nexus() {
  local line=$COMP_LINE rest words=() c=-1 i piece
  # Bash breaks words at = and :, as in --url=http://host:7470, so pieces with no space between are one word again.
  for (( i = 0; i <= COMP_CWORD; i++ )); do
    piece=\${COMP_WORDS[i]}
    rest=\${line#"\${line%%[![:space:]]*}"}
    if [[ $i -eq 0 || \${#rest} -ne \${#line} ]]; then c=$((c + 1)); words[c]=$piece; else words[c]=\${words[c]}$piece; fi
    line=\${rest#"$piece"}
  done
  local cur=\${words[c]} prev=\${words[c-1]}
  [[ $cur == "\${COMP_WORDS[COMP_CWORD]}" ]] || return 0
  local flags valued first group="" n=0 skip="" word ids="" conn=()
  _nexus_spec ""
  for (( i = 1; i < c; i++ )); do
    word=\${words[i]}
    if [[ -n $skip ]]; then
      [[ $skip == --url || $skip == --socks ]] && conn+=("$skip" "$(_nexus_unquoted "$word")")
      skip=""; continue
    fi
    case $word in
      --url=*|--socks=*) conn+=("$(_nexus_unquoted "$word")") ;;
      --*=*) ;;
      -*) [[ " $valued " == *" $word "* ]] && skip=$word ;;
      *)
        if [[ -z $group ]]; then group=$word; _nexus_spec "$word"
        elif [[ $group != - && $n -eq 0 ]] && _nexus_spec "$group $word"; then group=-
        else n=$((n + 1)); group=-
        fi ;;
    esac
  done
  COMPREPLY=()
  if [[ -n $skip ]]; then
    case $prev in
${Object.entries(valueNames).map(([flag, kind]) => `      ${flag}) COMPREPLY=( $(compgen -W "$(_nexus_ids ${kind}s \${conn[@]+"\${conn[@]}"})" -- "$cur") ) ;;`).join("\n")}
      *)
        if type compopt >/dev/null 2>&1; then compopt -o default
        else while IFS= read -r word; do COMPREPLY+=("$word"); done < <(compgen -f -- "$cur")
        fi ;;
    esac
  elif [[ $cur == -* ]]; then COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  elif [[ -z $group ]]; then COMPREPLY=( $(compgen -W "${words(tops)}" -- "$cur") )
  elif [[ $n -eq 0 ]]; then
    [[ $group != - ]] && ids=$(_nexus_subs "$group")
    case $first in
      thread) ids="$ids @last $(_nexus_ids threads \${conn[@]+"\${conn[@]}"})" ;;
      project) ids="$ids $(_nexus_ids projects \${conn[@]+"\${conn[@]}"})" ;;
    esac
    COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
  fi
}
# A bash without compopt, as macOS's 3.2, cannot ask for file names' quoting and slashes only where it completes them.
if type compopt >/dev/null 2>&1; then complete -F _nexus nexus; else complete -o filenames -F _nexus nexus; fi
`;
}

function zsh({ names, tops, groups, specOf }: Model): string {
  const spec = (pattern: string, s: Spec) => `    ${pattern}) flags=(${words(s.flags)}) valued=(${words(s.valued)}) first=${s.first} ;;`;
  return `# nexus completion for zsh, printed by \`nexus completion zsh\`. Turn it on with: source <(nexus completion zsh)
_nexus_ids() { command node -e '${idsScript}' "$@" 2>/dev/null; }
_nexus_spec() {
  case "$1" in
${spec(`""`, specOf(null))}
${names.map((name) => spec(`"${name}"`, specOf(name))).join("\n")}
    *) return 1 ;;
  esac
}
_nexus_subs() {
  case "$1" in
${groups.map((g) => `    "${g.top}") echo "${words(g.subs)}" ;;`).join("\n")}
  esac
}
_nexus() {
  local -a flags valued ids conn
  local first group="" n=0 skip="" i word
  _nexus_spec ""
  for (( i = 2; i < CURRENT; i++ )); do
    word=\${words[i]}
    if [[ -n $skip ]]; then
      [[ $skip == --url || $skip == --socks ]] && conn+=( $skip \${(Q)word} )
      skip=""; continue
    fi
    case $word in
      --url=*|--socks=*) conn+=( \${(Q)word} ) ;;
      --*=*) ;;
      -*) (( \${valued[(Ie)$word]} )) && skip=$word ;;
      *)
        if [[ -z $group ]]; then group=$word; _nexus_spec "$word"
        elif [[ $group != - && $n -eq 0 ]] && _nexus_spec "$group $word"; then group=-
        else n=$((n + 1)); group=-
        fi ;;
    esac
  done
  if [[ -n $skip ]]; then
    case \${words[CURRENT-1]} in
${Object.entries(valueNames).map(([flag, kind]) => `      ${flag}) compadd -- $(_nexus_ids ${kind}s $conn) ;;`).join("\n")}
      *) _files ;;
    esac
  elif [[ $PREFIX == -* ]]; then compadd -- $flags
  elif [[ -z $group ]]; then compadd -- ${words(tops)}
  elif (( n == 0 )); then
    [[ $group != - ]] && ids=( $(_nexus_subs "$group") )
    case $first in
      thread) ids+=( @last $(_nexus_ids threads $conn) ) ;;
      project) ids+=( $(_nexus_ids projects $conn) ) ;;
    esac
    compadd -- $ids
  fi
}
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }
compdef _nexus nexus
`;
}

function fish({ names, tops, groups, specOf }: Model): string {
  const spec = (pattern: string, s: Spec) => `        case ${pattern}\n            printf '%s\\n' '${words(s.flags)}' '${words(s.valued)}' '${s.first}'`;
  return `# nexus completion for fish, printed by \`nexus completion fish\`. Turn it on with: nexus completion fish | source
function __nexus_ids
    command node -e '${idsScript}' $argv 2>/dev/null
end
function __nexus_spec
    switch "$argv[1]"
${spec(`""`, specOf(null))}
${names.map((name) => spec(`"${name}"`, specOf(name))).join("\n")}
        case '*'
            return 1
    end
end
function __nexus_subs
    switch "$argv[1]"
${groups.map((g) => `        case "${g.top}"\n            string split ' ' '${words(g.subs)}'`).join("\n")}
    end
end
function __nexus_complete
    set -l tokens (commandline -opc)
    set -l cur (commandline -ct)
    set -l spec (__nexus_spec "")
    set -l group ""
    set -l n 0
    set -l skip ""
    set -l found
    set -l conn
    for word in $tokens[2..-1]
        if test -n "$skip"
            contains -- $skip --url --socks; and set -a conn $skip $word
            set skip ""
            continue
        end
        if string match -q -- '--url=*' $word; or string match -q -- '--socks=*' $word
            set -a conn $word
        else if string match -q -- '--*=*' $word
            continue
        else if string match -q -- '-*' $word
            contains -- $word (string split ' ' $spec[2]); and set skip $word
        else if test -z "$group"
            set group $word
            set found (__nexus_spec $word); and set spec $found
        else if test "$group" != - -a $n -eq 0; and set found (__nexus_spec "$group $word")
            set spec $found
            set group -
        else
            set n (math $n + 1)
            set group -
        end
    end
    if test -n "$skip"
        switch $tokens[-1]
${Object.entries(valueNames).map(([flag, kind]) => `            case ${flag}\n                __nexus_ids ${kind}s $conn`).join("\n")}
            case '*'
                __fish_complete_path $cur
        end
    else if string match -q -- '-*' $cur
        string split ' ' $spec[1]
    else if test -z "$group"
        string split ' ' '${words(tops)}'
    else if test $n -eq 0
        test "$group" != -; and __nexus_subs $group
        switch "$spec[3]"
            case thread
                echo @last
                __nexus_ids threads $conn
            case project
                __nexus_ids projects $conn
        end
    end
end
complete -c nexus -f -a '(__nexus_complete)'
`;
}

export const completionScript = (shell: Shell, commands: Readonly<Record<string, Command>>) => ({ zsh, bash, fish })[shell](modelOf(commands));
