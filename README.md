# Movie Rating Sync

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="GPL-3.0 License">
  <img src="https://img.shields.io/badge/Platform-Tampermonkey%20%7C%20Violentmonkey-orange" alt="Platform Support">
  <img src="https://img.shields.io/badge/Status-Active-success" alt="Status Active">
</p>

---

🌐 **Language / Выберите язык:**
* [🇺🇸 English (Default)](#-movie-rating-sync-english)
* [🇷🇺 Русский](#-movie-rating-sync-русский)

---

## 🇺🇸 Movie Rating Sync (English)

A cross-platform userscript to sync, backup, and migrate your movie ratings between **Kinopoisk**, **IMDb**, and **Letterboxd**.

### ✨ Features

* **🔄 Full Cross-Platform Support** — Import and export functionalities are available across all supported websites.
* **📦 Universal Format** — Download your ratings from any service into a structured CSV file.
* **🧠 Smart Title Matching** — Utilizes transliteration, fuzzy search, and release year tolerance to help map titles across different services.
* **⚡ Dual Sync Modes:**
  * *Normal Mode* — Skips already rated/watched titles to save time.
  * *Replace Mode* — Overwrites existing ratings with the latest data from your file.
* **🛡️ Adaptive Throttling** — Automatically adjusts request speed based on server responses to avoid rate limits (429 errors).
* **🔍 Deep Search** — An optional HTTP search fallback for titles not found in the local cache. 

> ⚠️ **Note on Matching:** Title translation and matching across networks is complex. The deep search is not perfect — some rare, indie, or localized titles may require manual adjustment during the sync process.

### 📊 Supported Services

| Service | Export | Import |
| :--- | :---: | :---: |
| **Kinopoisk** | ✅ | ✅ |
| **IMDb** | ✅ | ✅ |
| **Letterboxd** | ✅ | ✅ |

### 🚀 Installation

1. Install a userscript manager of your choice:
   * [Tampermonkey](https://www.tampermonkey.net/) *(Recommended)*
   * [Violentmonkey](https://violentmonkey.github.io/)
2. Open the [`movie-ratings-sync.user.js`](movie-ratings-sync.user.js) file in this repository.
3. Click the **"Raw"** button — your userscript manager will automatically prompt you to install the script.

### 📖 How To Use

#### Step 1. Export Ratings to CSV
1. Log into your profile on the **source** website (e.g., Kinopoisk).
2. Click the **📥 Export ratings to CSV** button and save the file.

#### Step 2. Import CSV to Target Platform
1. Log into the **destination** website (e.g., IMDb).
2. Click **📥 Import** (or **🔄 Hard Replace** if you want to overwrite existing ratings).
3. Select your downloaded CSV file and monitor the synchronization process.

---

## 🇷🇺 Movie Rating Sync (Русский)

Кроссплатформенный пользовательский скрипт для синхронизации, резервного копирования и переноса оценок фильмов между **Кинопоиском**, **IMDb** и **Letterboxd**.

### ✨ Возможности

* **🔄 Полная кроссплатформенность** — Импорт и экспорт данных работает на всех поддерживаемых сайтах.
* **📦 Универсальный формат** — Выгрузка ваших оценок с любого сервиса в единый формат CSV.
* **🧠 Умный поиск** — Алгоритм сопоставления использует транслитерацию, нечёткое сравнение названий и допуск по году для поиска фильмов на разных сервисах.
* **⚡ Два режима работы:**
  * *Обычный* — Пропускает уже оценённые или просмотренные фильмы, экономя время.
  * *Жёсткий* — Перезаписывает существующие оценки актуальными данными из вашего файла.
* **🛡️ Адаптивная задержка** — Скрипт автоматически подстраивает скорость работы под лимиты серверов, защищая от блокировок (ошибок 429).
* **🔍 Глубокий поиск** — Резервный HTTP-поиск для фильмов, которые не удалось найти в локальном кэше.

> ⚠️ **Предупреждение о поиске:** Алгоритм глубокого поиска не идеален. Из-за разницы в базах данных некоторых сервисов, редкие или локализованные фильмы могут не найтись автоматически и потребовать ручной проверки.

### 📊 Поддерживаемые сервисы

| Сервис | Экспорт | Импорт |
| :--- | :---: | :---: |
| **Кинопоиск** | ✅ | ✅ |
| **IMDb** | ✅ | ✅ |
| **Letterboxd** | ✅ | ✅ |

### 🚀 Установка

1. Установите менеджер пользовательских скриптов:
   * [Tampermonkey](https://www.tampermonkey.net/) *(Рекомендуется)*
   * [Violentmonkey](https://violentmonkey.github.io/)
2. Откройте файл [`movie-ratings-sync.user.js`](movie-ratings-sync.user.js) в этом репозитории.
3. Нажмите кнопку **«Raw»** — менеджер скриптов автоматически предложит установку.

### 📖 Инструкция

#### Шаг 1. Экспорт оценок в CSV
1. Перейдите в свой профиль на **исходном** сервисе (например, на Кинопоиск).
2. Нажмите появившуюся кнопку **📥 Экспорт оценок в CSV** и сохраните файл.

#### Шаг 2. Импорт оценок из CSV
1. Перейдите на **целевой** сервис (например, IMDb), предварительно войдя в свой аккаунт.
2. Нажмите кнопку **📥 Импортировать** (или **🔄 Жёсткий импорт**, если нужно перезаписать старые оценки).
3. Выберите скачанный ранее CSV-файл и дождитесь окончания процесса.

---

### 📄 License

Distributed under the [GPL-3.0](LICENSE) License.

### 🤝 Support & Contribution

Found a bug or have a feature request? Feel free to open an [issue](https://github.com/Smokelweiss/MovieRatingsSync/issues). Pull requests are welcome!
