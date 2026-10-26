/* MonBudget - lecture des relevés bancaires
   - BoursoBank : PDF (lecture par colonnes, positions X)
   - Revolut : CSV (export depuis l'app Revolut, en français ou en anglais)
   Fichier partagé entre le navigateur et les tests Node. */
(function (root) {
  'use strict';

  // ---------- Outils ----------
  function parseFrAmount(s) {
    // "1.247,00" ou "1 247,00" ou "-12,50" -> nombre
    var t = String(s).replace(/[\s  €¤]/g, '').replace(/\./g, '').replace(',', '.');
    var n = parseFloat(t);
    return isNaN(n) ? null : n;
  }
  function frDateToIso(d) { // 02/09/2026 -> 2026-09-02
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
    return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  // ---------- BoursoBank PDF ----------
  // pages : [{ height, items: [{ str, x0, x1, y }] }] (y depuis le haut de la page)
  var DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
  var AMOUNT_RE = /^\d{1,3}(\.\d{3})*,\d{2}$/;

  function groupRows(items, tol) {
    var sorted = items.slice().sort(function (a, b) { return a.y - b.y || a.x0 - b.x0; });
    var rows = [];
    sorted.forEach(function (it) {
      var last = rows[rows.length - 1];
      if (last && Math.abs(it.y - last.y) <= tol) last.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    });
    rows.forEach(function (r) { r.items.sort(function (a, b) { return a.x0 - b.x0; }); });
    return rows;
  }

  function parseBoursoPages(pages) {
    var txs = [];
    var meta = { openingBalance: null, closingBalance: null, periodStart: null, periodEnd: null, pagesWithTable: 0 };
    var allText = '';

    pages.forEach(function (page, pi) {
      var items = page.items.filter(function (it) { return it.str && it.str.trim() !== ''; })
        .map(function (it) { return { str: it.str.trim(), x0: it.x0, x1: it.x1, y: it.y }; });
      var rowsAll = groupRows(items, 2.5);
      rowsAll.forEach(function (r) { allText += r.items.map(function (i) { return i.str; }).join(' ') + '\n'; });

      var deb = items.find(function (i) { return /^D[ée]bit$/i.test(i.str); });
      var cre = items.find(function (i) { return /^Cr[ée]dit$/i.test(i.str); });
      var val = items.find(function (i) { return /^Valeur$/i.test(i.str); });
      if (!deb || !cre) return;
      meta.pagesWithTable++;
      var split = (deb.x1 + cre.x1) / 2;            // frontière débit / crédit
      var amountMinX = deb.x0 - 40;                   // zone des montants
      var labelMaxX = val ? val.x0 - 4 : deb.x0 - 40; // le libellé s'arrête avant "Valeur"
      var headerY = Math.max(deb.y, cre.y);

      var rows = rowsAll.filter(function (r) { return r.y > headerY + 3; });
      var cur = null, lastY = null;
      for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        var txt = r.items.map(function (i) { return i.str; }).join(' ');
        if (/Nouveau\s*solde|SOLDE\s*AU|Montant\s*frais/i.test(txt)) { cur = null; continue; }
        var first = r.items[0];
        var amounts = r.items.filter(function (i) { return i.x0 >= amountMinX && AMOUNT_RE.test(i.str); });
        if (DATE_RE.test(first.str) && first.x0 < 90 && amounts.length) {
          var a = amounts[amounts.length - 1];
          var label = r.items.filter(function (i) { return i.x0 > first.x1 && i.x1 <= labelMaxX + 2; })
            .map(function (i) { return i.str; }).join(' ').replace(/\s+/g, ' ').trim();
          cur = {
            date: frDateToIso(first.str),
            label: label,
            extra: '',
            amount: parseFrAmount(a.str),
            side: a.x1 < split ? 'debit' : 'credit'
          };
          txs.push(cur);
          lastY = r.y;
        } else if (cur && first.x0 >= 90 && first.x0 < labelMaxX && lastY !== null && r.y - lastY < 16) {
          // ligne de complément du libellé (référence, nom du bénéficiaire...)
          cur.extra += (cur.extra ? ' ' : '') + r.items.filter(function (i) { return i.x0 < labelMaxX; }).map(function (i) { return i.str; }).join(' ');
          lastY = r.y;
        } else {
          lastY = null;
        }
      }
    });

    var m;
    if ((m = /SOLDE\s*AU\s*:?\s*(\d{2}\/\d{2}\/\d{4})\s*([\d.]+,\d{2})/i.exec(allText))) meta.openingBalance = parseFrAmount(m[2]);
    if ((m = /Nouveau\s*solde\s*en\s*EUR\s*:?\s*(-?[\d.]+,\d{2})/i.exec(allText))) meta.closingBalance = parseFrAmount(m[1]);
    if ((m = /du\s*(\d{2}\/\d{2}\/\d{4})\s*au\s*(\d{2}\/\d{2}\/\d{4})/i.exec(allText))) { meta.periodStart = frDateToIso(m[1]); meta.periodEnd = frDateToIso(m[2]); }

    var totalDebit = round2(txs.filter(function (t) { return t.side === 'debit'; }).reduce(function (s, t) { return s + t.amount; }, 0));
    var totalCredit = round2(txs.filter(function (t) { return t.side === 'credit'; }).reduce(function (s, t) { return s + t.amount; }, 0));
    meta.totalDebit = totalDebit; meta.totalCredit = totalCredit;
    meta.balanceCheck = (meta.openingBalance !== null && meta.closingBalance !== null)
      ? Math.abs(round2(meta.openingBalance + totalCredit - totalDebit) - meta.closingBalance) < 0.01
      : null;
    meta.isBourso = /bourso/i.test(allText);
    return { transactions: txs, meta: meta };
  }

  // ---------- Revolut CSV ----------
  function splitCsvLine(line, sep) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function norm(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }

  function parseRevolutCsv(text) {
    text = text.replace(/^﻿/, '');
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) throw new Error('Fichier CSV vide');
    var sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';
    var head = splitCsvLine(lines[0], sep).map(norm);
    function col() {
      for (var i = 0; i < arguments.length; i++) { var j = head.indexOf(arguments[i]); if (j >= 0) return j; }
      return -1;
    }
    var cType = col('type');
    var cProduct = col('product', 'produit');
    var cStart = col('started date', 'date de debut');
    var cDone = col('completed date', 'date de fin', 'date d\'execution', 'date de finalisation');
    var cDesc = col('description');
    var cAmount = col('amount', 'montant');
    var cFee = col('fee', 'frais');
    var cCur = col('currency', 'devise');
    var cState = col('state', 'etat', 'statut');
    if (cAmount < 0 || cDesc < 0 || (cStart < 0 && cDone < 0)) {
      throw new Error('Colonnes Revolut introuvables (attendu : Date, Description, Montant). En-tête lu : ' + head.join(' | '));
    }
    var txs = [], skipped = 0;
    for (var k = 1; k < lines.length; k++) {
      var c = splitCsvLine(lines[k], sep);
      var state = cState >= 0 ? norm(c[cState] || '') : 'completed';
      if (state && !/^(completed|termine|effectue|complete|finalise)/.test(state)) { skipped++; continue; }
      var rawDate = (cDone >= 0 && c[cDone]) ? c[cDone] : c[cStart];
      var d = /(\d{4})-(\d{2})-(\d{2})/.exec(rawDate || '') || null;
      var iso = d ? d[1] + '-' + d[2] + '-' + d[3] : (function () { var f = /(\d{2})\/(\d{2})\/(\d{4})/.exec(rawDate || ''); return f ? f[3] + '-' + f[2] + '-' + f[1] : null; })();
      if (!iso) { skipped++; continue; }
      var amt = parseFloat(String(c[cAmount]).replace(/[\s ]/g, '').replace(',', '.'));
      var fee = cFee >= 0 ? parseFloat(String(c[cFee] || '0').replace(/[\s ]/g, '').replace(',', '.')) || 0 : 0;
      if (isNaN(amt)) { skipped++; continue; }
      var net = round2(amt - fee);
      if (net === 0) { skipped++; continue; }
      txs.push({
        date: iso,
        label: c[cDesc] || '',
        extra: [cType >= 0 ? c[cType] : '', cProduct >= 0 ? c[cProduct] : ''].filter(Boolean).join(' '),
        type: cType >= 0 ? (c[cType] || '') : '',
        product: cProduct >= 0 ? (c[cProduct] || '') : '',
        currency: cCur >= 0 ? (c[cCur] || 'EUR') : 'EUR',
        amount: Math.abs(net),
        side: net < 0 ? 'debit' : 'credit'
      });
    }
    return { transactions: txs, meta: { skipped: skipped, totalDebit: round2(txs.filter(function (t) { return t.side === 'debit'; }).reduce(function (s, t) { return s + t.amount; }, 0)), totalCredit: round2(txs.filter(function (t) { return t.side === 'credit'; }).reduce(function (s, t) { return s + t.amount; }, 0)) } };
  }

  // ---------- Libellés et catégories ----------
  function cleanLabel(raw) {
    var s = String(raw || '');
    s = s.replace(/^(CARTE|AVOIR)\s*\d{2}\/\d{2}\/\d{2,4}\s*/i, '');
    s = s.replace(/^RETRAIT\s*DAB\s*\d{2}\/\d{2}\/\d{2,4}\s*/i, 'Retrait ');
    s = s.replace(/\s*\d?\s*CB\*\d+\s*$/i, '');
    s = s.replace(/^PRLV\s*SEPA\s*/i, '');
    s = s.replace(/^VIR\s*(INST|SEPA)?\s*(Virement\s*)?/i, 'Virement ');
    s = s.replace(/^\*?FRAIS\s*/i, 'Frais ');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return 'Opération';
    if (s === s.toUpperCase()) s = s.charAt(0) + s.slice(1).toLowerCase();
    return s.length > 40 ? s.slice(0, 40).trim() : s;
  }

  // Clé marchand pour mémoriser les catégories choisies par l'utilisateur
  function merchantKey(label) {
    return norm(cleanLabel(label)).replace(/\d+/g, '').replace(/[^a-z]+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  }

  var RULES = [
    ['frais_bancaires', /FRAIS|BOURSO\s*PROTECT|COTISATION|COMMISSION/],
    ['logement', /CITYA|GERANCE|LOYER|EDF|ENGIE|TOTALENERGIES|EAU DE PARIS|SAUR|VEOLIA/],
    ['assurance', /MACIF|MAIF|AXA|ALLIANZ|MATMUT|GROUPAMA|ASSURANCE/],
    ['abonnements', /FREE\s*MOBILE|FREE\s*TELECOM|FREETELECOM|FREEMOBILE|ORANGE|SFR|BOUYGUES|NETFLIX|SPOTIFY|DEEZER|DISNEY|CANAL|ANTHROPIC|OPENAI|APPLE\.COM|GOOGLE\s*\*|ICLOUD|YOUTUBE|PRIME\s*VIDEO/],
    ['transport', /NAVIGO|RATP|SNCF|UBER(?!\s*EATS)|\bBOLT\b|\bLIME\b|VELIB|TOTAL\s*ENERGIES\s*STATION|ESSO|SHELL|PARKING|BLABLACAR/],
    ['sante', /PHARMACIE|PHIE|PHCIE|DOCTOLIB|MEDECIN|DENTISTE|OPTIC|LABO|CROIZAT|HOPITAL|CLINIQUE|KINE/],
    ['alimentation', /CARREFOUR|FRANPRIX|FP\s*PARIS|MONOP|MONOPRIX|LIDL|ALDI|LECLERC|AUCHAN|INTERMARCHE|PICARD|NATURALIA|BIOCOOP|CASINO|G20|SPAR|U\s*EXPRESS|FOURNIL|BOULANG|\bBOUL\b|BASBOUL|PRIMEUR|MARKET|EXOTIK|ALIMENTA|BOUCHERIE|FROMAG|GRAINE|8\s*A\s*HUIT|NATURE\s*SHOP|DISTRI/],
    ['restaurants', /PRET\s*A\s*MANGER|PRETAMANGER|MC\s*DO|MCDONALD|BURGER|KFC|DAMDOUM|BOUILLON|LE\s*FERBER|LEFERBER|CAMELIA|PELLEPORT|GAMBETTA|ITALY|PIZZ|SUSHI|RESTAU|BRASSERIE|CAFE|COFFEE|BOL\b|JOAYO|UBER\s*EATS|DELIVEROO|FORTUNA|MONCOCO|STARBUCKS|PAUL\b/],
    ['achats_ligne', /AMAZON|PAYPAL|VINTED|CDISCOUNT|FNAC|ZALANDO|SHEIN|ALIEXPRESS|LEBONCOIN/],
    ['shopping', /PRIMARK|FOOT\s*LOCKER|FOOTLOCKER|HEMA|ZARA|H&M|UNIQLO|DECATHLON|KIABI|SEPHORA|ACTION\b|IKEA|LEROY/],
    ['loisirs', /CINEMA|UGC|PATHE|MK2|FNAC\s*SPECTACLE|TICKETMASTER|MUSEE|SPORT|SALLE|BASIC\s*FIT|LOCENMAIN|TABAC|BMV/],
    ['especes', /^RETRAIT|RETRAIT\s*DAB|^RETRAIT/]
  ];

  function categorize(label, extra) {
    var u = (String(label || '') + ' ' + String(extra || '')).toUpperCase().replace(/’/g, "'");
    var l = String(label || '').toUpperCase();
    if (/^RETRAIT/.test(l)) return 'especes';
    for (var i = 0; i < RULES.length; i++) if (RULES[i][1].test(l) || RULES[i][1].test(u)) return RULES[i][0];
    if (/^VIR/.test(l)) return 'virements';
    return 'divers';
  }

  // Type d'opération : dépense, revenu, ou virement interne (entre mes comptes, exclu des budgets)
  function classify(tx, account, ownNames) {
    var u = (tx.label + ' ' + (tx.extra || '')).toUpperCase();
    var names = (ownNames || []).map(function (n) { return n.toUpperCase().replace(/\s+/g, '\\s*'); }).filter(Boolean);
    var isOwn = names.some(function (n) { return new RegExp('VIR.*' + n).test(tx.label.toUpperCase()); });
    var internal = /COMPTE\s*SUR\s*LIVRE|LIVRET|REVOLUT/.test(tx.label.toUpperCase()) || isOwn;
    if (account === 'revolut') {
      var t = norm(tx.type || ''), p = norm(tx.product || '');
      if (/topup|recharge|exchange|change/.test(t) || /savings|epargne|pocket|coffre/.test(p) || /pocket|coffre|vault|top-up|top up|rechargement|boursobank|boursorama/i.test(tx.label)) internal = true;
    }
    if (internal) return 'interne';
    if (tx.side === 'debit') return 'depense';
    if (/^AVOIR|REMBOURSEMENT|REFUND/i.test(tx.label) || norm(tx.type || '') === 'refund' || norm(tx.type || '') === 'remboursement') return 'avoir';
    return 'revenu';
  }

  var api = {
    parseFrAmount: parseFrAmount,
    parseBoursoPages: parseBoursoPages,
    parseRevolutCsv: parseRevolutCsv,
    cleanLabel: cleanLabel,
    merchantKey: merchantKey,
    categorize: categorize,
    classify: classify
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MBParser = api;
})(typeof self !== 'undefined' ? self : this);
