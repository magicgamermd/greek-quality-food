# Partner / Supplier Enrichment from Microinvest

При първоначалната ETL миграция от Greek Foods backup-а партньорите
и доставчиците не разполагаха с EIK / VAT / city / contact_person —
тези полета бяха NULL в backup-а защото Greek Foods не е попълвал
данните в собственото си UI.

Microinvest export-ите (PRODAJBIEXPORT.xml + DOSTAVKIEXPORT.xml)
обаче съдържат пълните данни — те са истинският източник.

## Стъпки

```bash
# 1. Изтегли реалните XML-и от microinvest-export папката
#    (вече ги имаме в Greek Foods Platform)

# 2. Парсни тях → enrichment JSON
python3 scripts/enrichment/parse-microinvest-xml.py

# 3. Match по име + UPDATE production DB
python3 scripts/enrichment/match-and-update.py

# 4. Run генерирания SQL
psql $DATABASE_PUBLIC_URL -v ON_ERROR_STOP=0 -f /tmp/enrichment.sql
```

## Резултати (2026-05-13)

- 54/429 партньори: EIK + VAT + city + МОЛ
- 13/64 доставчици: EIK + VAT + city + МОЛ

Останалите партньори (~375) са били тестови / неактивни записи в Greek
Foods. При следваща сесия можем да добавим още чрез:
- Manual entry в UI (с CompanyBook auto-fill по ЕИК)
- По-нови Microinvest export-и
