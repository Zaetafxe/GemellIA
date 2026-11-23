import 'package:flutter_test/flutter_test.dart';
import 'package:visitoria/main.dart';

void main() {
  test('el código del expositor viaja dentro del Service UUID', () {
    final uuid = codeToUuid('TAAXP7');
    expect(uuid, '56495349-5441-4000-8000-544141585037');
    expect(uuidToCode(uuid), 'TAAXP7');
    expect(uuidToCode(uuid.toUpperCase()), 'TAAXP7');
    expect(uuidToCode('0000180f-0000-1000-8000-00805f9b34fb'), isNull);
  });

  test('etiquetas de proximidad por RSSI', () {
    expect(proximity(-55), 'Platicando');
    expect(proximity(-75), 'Cerca');
    expect(proximity(-90), 'Lejos');
  });
}
