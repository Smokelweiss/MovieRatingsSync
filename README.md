# Movie Rating Sync (Синхронизация Кинооценок)

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="GPL-3.0 License">
  <img src="https://img.shields.io/badge/Platform-Tampermonkey%20%7C%20Violentmonkey-orange" alt="Platform Support">
  <img src="https://img.shields.io/badge/Status-Active-success" alt="Status Active">
</p>

<p align="center">
  Userscript for transferring, synchronizing, and backing up movie ratings between
  <a href="https://www.kinopoisk.ru/">Kinopoisk</a>,
  <a href="https://www.imdb.com/">IMDb</a>
  and
  <a href="https://letterboxd.com/">Letterboxd</a>.
</p>

<p align="center">
  🇷🇺 <a href="./README.ru.md">Russian version</a>
</p>

---

## Features

* 🔄 Import and export ratings across services
* 📦 Universal CSV format for backups
* 🧠 Smart movie matching (transliteration, fuzzy matching, year)
* ⚡ Two import modes — normal and hard (with overwrite)
* 🛡️ Adaptive throttling to prevent rate limits
* 🔍 Deep HTTP fallback search for missing movies

---

## Supported Services

| Service     | Export | Import |
| :---------- | :---: | :----: |
| Kinopoisk   |   ✅   |   ✅   |
| IMDb        |   ✅   |   ✅   |
| Letterboxd  |   ✅   |   ✅   |

---

## Installation

### 1. Install a userscript manager

* [Tampermonkey](https://www.tampermonkey.net/) (recommended)
* [Violentmonkey](https://violentmonkey.github.io/)

### 2. Install the script

Open the file: [`movie-rating-sync.user.js`](./movie-rating-sync.user.js)

Click the **Raw** button, and your userscript manager will automatically prompt installation.

---

## Usage

### Export

1. Open your profile on the source service  
2. Click `📥 Export ratings`  
3. Save the CSV file  

### Import

1. Open the target service  
2. Click `📥 Import` or `🔄 Hard Import`  
3. Select the CSV file  
4. Wait for synchronization to complete  

---

## Use Cases

* Transfer ratings between Kinopoisk, IMDb, and Letterboxd
* Export movie ratings to CSV
* Backup movie ratings
* Migrate between movie platforms
* Synchronize ratings across platforms

---

## Hard Import Notes

Automatic movie matching is not always perfect.

It uses:
* transliteration
* fuzzy matching
* year tolerance
* HTTP fallback search

Rare or localized movies may require manual verification. The script can sometimes mismatch them.

---

## License

GPL-3.0 License

---

## Contribution

Issues and pull requests are welcome.
