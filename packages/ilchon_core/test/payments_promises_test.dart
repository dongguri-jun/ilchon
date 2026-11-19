@Tags(['web'])
library;

import 'package:ilchon_core/ilchon_core.dart';
import 'package:test/test.dart';

void main() {
  final amounts = [1, 5, 99, 100, 101, 1005, 123456, 99999999999, maxMinor].map((m) => Money.fromMinor(m)!);

  test('an amount shown in the amount field reads back as the same amount', () {
    for (final currency in Currency.values) {
      for (final amount in amounts) {
        final field = minorToInput(amount.minor, currency);
        expect(parseMinor(field, currency), amount, reason: '$field in ${currency.code}');
      }
    }
  });

  test('the amount field text is already in the shape the field keeps', () {
    for (final currency in Currency.values) {
      for (final amount in amounts.where((m) => m.minor ~/ currency.minorPerUnit < 1000000000)) {
        final field = minorToInput(amount.minor, currency);
        expect(sanitizeAmount(field, currency), field, reason: currency.code);
        expect(sanitizeAmount(field, currency, AmountInputMode.paste), field, reason: currency.code);
      }
    }
  });

  test('the bitcoin a card shows is the amount its link asks for', () {
    const address = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    for (final value in [1, 98039, 100000000, 123456789, maxSats]) {
      final sats = Sats.fromInt(value)!;
      final card = onchainCardValues(OnchainRequest(address, sats));
      expect(parseOnchainRequest(card.link)?.sats, sats);
      expect(card.link, endsWith('amount=${card.btc}'));
    }
  });

  test('chat text cut into parts joins back into the same text', () {
    for (final text in ['', ' ', 'pay me', ' two  spaces\tand tab\n', 'line sep　wide nbsp', '﻿mark']) {
      expect(splitPaymentText(text).map((part) => part.text).join(), text);
    }
  });

  test('amounts never show up in logs or error messages', () {
    expect('${Money.fromMinor(150000)}', isNot(contains('150000')));
    expect('${Sats.fromInt(98039)}', isNot(contains('98039')));
  });
}
