#!/usr/bin/env python3
"""
Mapa CDVs RS - Gerenciador de Sugestões de Contato (CLI)
Comandos:
  python -m scripts.manage_suggestions list [--all]
  python -m scripts.manage_suggestions approve <ID>
  python -m scripts.manage_suggestions reject <ID>
"""

import sys

from scripts.suggestions import SuggestionsStore


def format_table(rows: list[list[str]], headers: list[str]) -> str:
    col_widths = [len(h) for h in headers]
    for row in rows:
        for i, val in enumerate(row):
            col_widths[i] = max(col_widths[i], len(str(val)))

    header_line = " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers))
    sep_line = "-+-".join("-" * col_widths[i] for i in range(len(headers)))
    row_lines = [
        " | ".join(str(cell).ljust(col_widths[i]) for i, cell in enumerate(row))
        for row in rows
    ]
    return f"{header_line}\n{sep_line}\n" + "\n".join(row_lines)


def cmd_list(show_all: bool = False):
    suggestions = SuggestionsStore.load()
    if not show_all:
        suggestions = [s for s in suggestions if s.get('status') == 'pending']

    if not suggestions:
        status_label = "pendente" if not show_all else "cadastrada"
        print(f"Nenhuma sugestão {status_label} encontrada.")
        return

    headers = ["ID", "Status", "CDV", "Nome Contato", "Telefone", "WhatsApp", "Criado Em"]
    rows = []
    for s in suggestions:
        rows.append([
            s.get('id', ''),
            s.get('status', ''),
            f"{s.get('cdv_codigo', '')} ({s.get('cdv_nome', '')[:20]})",
            s.get('nome_contato', ''),
            s.get('telefone_formatado', s.get('telefone', '')),
            "Sim" if s.get('is_whatsapp') else "Não",
            (s.get('created_at', '')[:19]).replace('T', ' ')
        ])

    print("\n" + "=" * 80)
    print(f"📋 Sugestões de Contato ({len(suggestions)} itens)")
    print("=" * 80)
    print(format_table(rows, headers))
    print("=" * 80 + "\n")


def cmd_approve(suggestion_id: str):
    if not suggestion_id:
        print("Erro: Informe o ID da sugestão para aprovar. Ex: python -m scripts.manage_suggestions approve sug_abc123")
        sys.exit(1)

    try:
        approved = SuggestionsStore.approve(suggestion_id)
        print(f"✅ Sugestão '{suggestion_id}' APROVADA com sucesso!")
        print(f"   CDV: {approved.get('cdv_codigo')} - {approved.get('cdv_nome')}")
        print(f"   Contato: {approved.get('nome_contato')} ({approved.get('telefone_formatado')})")
        print("   O contato foi adicionado à base oficial de CDVs.")
    except Exception as e:
        print(f"❌ Erro ao aprovar sugestão: {e}")
        sys.exit(1)


def cmd_reject(suggestion_id: str):
    if not suggestion_id:
        print("Erro: Informe o ID da sugestão para rejeitar. Ex: python -m scripts.manage_suggestions reject sug_abc123")
        sys.exit(1)

    try:
        rejected = SuggestionsStore.reject(suggestion_id)
        print(f"🚫 Sugestão '{suggestion_id}' REJEITADA.")
        print(f"   CDV: {rejected.get('cdv_codigo')} - Contato: {rejected.get('nome_contato')}")
    except Exception as e:
        print(f"❌ Erro ao rejeitar sugestão: {e}")
        sys.exit(1)


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help', 'help'):
        print(__doc__)
        return

    cmd = args[0].lower()
    if cmd == 'list':
        show_all = '--all' in args
        cmd_list(show_all=show_all)
    elif cmd == 'approve':
        sug_id = args[1] if len(args) > 1 else ''
        cmd_approve(sug_id)
    elif cmd == 'reject':
        sug_id = args[1] if len(args) > 1 else ''
        cmd_reject(sug_id)
    else:
        print(f"Comando desconhecido '{cmd}'. Use: list, approve, reject")
        sys.exit(1)


if __name__ == '__main__':
    main()
