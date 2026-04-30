# MERT-M macOS Installer

Инсталация на MERT-M на клиентски Mac (Mac Mini M4 в офиса на МЕРТ-М).

## Какво съдържа

| Файл / папка            | Какво е                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `install.sh`            | Главен инсталационен скрипт — пуска се веднъж на нов Mac                  |
| `Start MERT-M.app`      | Двойно щракване → стартира Docker, backend, frontend, AI; отваря браузъра |
| `Stop MERT-M.app`       | Спира всички процеси и Docker контейнерите                                |
| `Update MERT-M.app`     | git pull → npm install → migrate → restart                                |
| `scripts/*.applescript` | Source файлове на launcher-ите                                            |

## Системни изисквания

- **macOS 13+** (Ventura или по-нова)
- **Apple Silicon препоръчителен** (M1/M2/M3/M4)
- **8 GB RAM минимум** (16 GB препоръчително)
- **20 GB свободно дисково място**
- **Internet** за първоначалната инсталация (не е нужен в работата)

## Стъпки за инсталация (на чист Mac)

### 1. Подготовка

- Влез в потребителския акаунт с админ права
- Свържи се с интернет за инсталация

### 2. Инсталирай OrbStack (или Docker Desktop)

- **OrbStack** (препоръчително): https://orbstack.dev
- Алтернатива: Docker Desktop https://docker.com/products/docker-desktop
- Стартирай го след инсталация

### 3. Прехвърли проекта

- Чрез USB stick: копирай папката `mert-m/` някъде временно (напр. `~/Downloads/`)
- Или чрез git: `git clone <repo-url> ~/Downloads/mert-m`

### 4. Пусни инсталатора

```bash
cd ~/Downloads/mert-m/macos-installer
bash install.sh
```

Скриптът ще:

1. Инсталира Homebrew, git, Node.js 22, Python 3.11
2. Провери Docker (ако липсва — спира и иска ръчна инсталация)
3. Инсталира Tailscale (за remote support)
4. Копира проекта в `/Applications/MERT-M/`
5. Генерира .env с уникални секрети
6. Инсталира npm зависимости
7. Стартира Postgres + Redis в Docker
8. Изпълнява migrations
9. Импортва каталога продукти + регистъра партньори (ако има .sql файлове)
10. Регистрира daily backup LaunchAgent в 03:00
11. Поставя иконките на десктопа

### 5. Стартирай Tailscale

- Отвори `Tailscale.app` от Applications
- Логни се с акаунта който разработчикът ти даде
- Това позволява remote SSH достъп от страна на разработчика за поддръжка

### 6. Първо стартиране

- Двойно щракване на **Start MERT-M** иконата на десктопа
- Браузърът ще се отвори на http://localhost:5174 след ~10 сек
- Влез с `admin@mertm.bg` (паролата е в `/Applications/MERT-M/warehouse-backend/.env` под `ADMIN_PASSWORD`)

## Дневен бекъп

`pg_dump` се изпълнява автоматично всеки ден в **03:00** и пази последните 30 копия в:

```
~/mertm-data/backups/mertm-YYYYMMDD-HHMMSS.sql.gz
```

Можеш да копираш тази папка периодично на external SSD или iCloud Drive за off-site backup.

## Когато има update от разработчика

1. Двойно щракване на **Update MERT-M** иконата
2. Терминалът ще се отвори и ще покаже стъпките
3. След ~30 сек MERT-M ще се рестартира с новата версия

## Remote поддръжка (за разработчика)

```bash
# Включи Tailscale на твоя Mac, после:
ssh magic@<tailscale-name-of-client-mac>
# Логове:
tail -f /tmp/mertm-{backend,frontend,ai}.log
# Restart:
open "/Applications/MERT-M/macos-installer/Stop MERT-M.app"
open "/Applications/MERT-M/macos-installer/Start MERT-M.app"
```

## Troubleshooting

### Браузърът не се отваря след клик на Start MERT-M

- Виж `/tmp/mertm-launcher.log`
- Виж `/tmp/mertm-backend.log` (грешки в backend)
- Виж `/tmp/mertm-frontend.log` (грешки в Vite)
- Provери че Docker e пуснат: `docker info`

### "Не може да се отвори, защото не е от identified developer"

- Десен бутон на иконата → Open → потвърди първия път
- След това двойно щракване работи нормално

### Restartване след crash

- Двойно щракване на **Stop MERT-M**, после **Start MERT-M**

### Database проблем

- Логове: `docker logs mertm-postgres-1`
- Възстановяване от backup:
  ```bash
  cd ~/mertm-data/backups
  gunzip < mertm-YYYYMMDD-HHMMSS.sql.gz | docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse
  ```
