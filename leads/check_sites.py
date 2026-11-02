"""Проверка сайтов из leads_website_redesign.xlsx.

Запуск:  pip install openpyxl requests
         python check_sites.py
Результат: leads_checked.xlsx рядом со скриптом.
"""
import re
from pathlib import Path

import requests
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill

HERE = Path(__file__).parent
SRC = HERE / "leads_website_redesign.xlsx"
OUT = HERE / "leads_checked.xlsx"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36"}
CURRENT_YEAR = 2026


def fetch(url):
    try:
        r = requests.get(url, headers=UA, timeout=20, allow_redirects=True)
        r.encoding = r.apparent_encoding or r.encoding
        return r, None
    except requests.RequestException as e:
        return None, type(e).__name__


def check(url):
    res = {}
    bare = re.sub(r"^https?://(www\.)?", "", url)
    r = err = None
    for cand in (url, "https://" + bare, "http://" + bare):
        r, err = fetch(cand)
        if r is not None:
            break
    if r is None:
        return {"Доступен": "Нет", "Код": err, "Вердикт": "Сайт не открывается — уточнить, жива ли компания"}
    html = r.text
    low = html.lower()
    res["Доступен"] = "Да" if r.status_code < 400 else "Нет"
    res["Код"] = r.status_code
    res["Итоговый адрес"] = r.url
    https_ok, _ = fetch("https://" + bare)
    res["HTTPS"] = "Да" if https_ok is not None and https_ok.status_code < 400 else "Нет"
    res["Мобильная версия (viewport)"] = "Да" if 'name="viewport"' in low or "name=viewport" in low else "Нет"
    years = [int(y) for y in re.findall(r"(?:©|&copy;|copyright)[^<]{0,40}?((?:19|20)\d{2})", low)]
    res["Год в копирайте"] = max(years) if years else ""
    if res["Год в копирайте"] == CURRENT_YEAR and "ucoz" in low:
        res["Год в копирайте"] = f"{CURRENT_YEAR} (ставит uCoz автоматически)"
    dates = [int(y) for y in re.findall(r"\b\d{1,2}[./]\d{1,2}[./]((?:19|20)\d{2})\b", html)]
    dates = [y for y in dates if y <= CURRENT_YEAR]
    res["Самая свежая дата в тексте"] = max(dates) if dates else ""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    res["Title"] = (m.group(1).strip() if m else "")[:120]
    res["Конструктор"] = "uCoz" if "ucoz" in low else ""
    res["Flash"] = "Да" if ".swf" in low else ""
    res["Таблицы для вёрстки"] = "Да" if low.count("<table") >= 5 else ""
    moved = re.search(r"(переехал|новый адрес|новом адресе|перешли на)", low)
    res["Переезд на новый домен"] = "Возможно" if moved else ""
    res["Онлайн-запись/форма"] = "Да" if re.search(r"<form[^>]*>(?:(?!</form>).)*(тел|phone|запис)", low, re.S) else "Нет"

    problems = []
    if res["HTTPS"] == "Нет": problems.append("нет HTTPS")
    if res["Мобильная версия (viewport)"] == "Нет": problems.append("нет мобильной версии")
    if isinstance(res["Год в копирайте"], int) and res["Год в копирайте"] < CURRENT_YEAR - 3:
        problems.append(f"копирайт {res['Год в копирайте']}")
    if res["Самая свежая дата в тексте"] and res["Самая свежая дата в тексте"] < CURRENT_YEAR - 3:
        problems.append(f"свежайшая дата в тексте {res['Самая свежая дата в тексте']}")
    if res["Конструктор"]: problems.append("uCoz/бесплатный поддомен")
    if res["Flash"]: problems.append("Flash")
    if res["Онлайн-запись/форма"] == "Нет": problems.append("нет формы заявки")
    if res["Переезд на новый домен"]:
        res["Вердикт"] = "Проверить: возможно, уже есть новый сайт. " + ", ".join(problems)
    elif res["Доступен"] == "Нет":
        res["Вердикт"] = f"Ошибка {r.status_code}: сайт удалён или не работает — уточнить, жива ли компания"
    else:
        res["Вердикт"] = ("Нужен новый сайт: " if len(problems) >= 2 else "Мелкие проблемы: ") + ", ".join(problems)
    return res


def main():
    wb = load_workbook(SRC)
    ws = wb["Лиды"]
    headers = [c.value for c in ws[1]]
    url_col = headers.index("Сайт") + 1
    new_cols = ["Доступен", "Код", "Итоговый адрес", "HTTPS", "Мобильная версия (viewport)",
                "Год в копирайте", "Самая свежая дата в тексте", "Title", "Конструктор", "Flash", "Таблицы для вёрстки",
                "Переезд на новый домен", "Онлайн-запись/форма", "Вердикт"]
    start = ws.max_column + 1
    for i, h in enumerate(new_cols):
        c = ws.cell(row=1, column=start + i, value=h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="305496")
    for row in range(2, ws.max_row + 1):
        url = ws.cell(row=row, column=url_col).value
        if not url:
            continue
        print(f"[{row - 1}] {url} ...", end=" ", flush=True)
        res = check(url)
        print(res.get("Вердикт"))
        for i, h in enumerate(new_cols):
            ws.cell(row=row, column=start + i, value=res.get(h, ""))
    wb.save(OUT)
    print(f"\nГотово: {OUT}")


if __name__ == "__main__":
    main()
