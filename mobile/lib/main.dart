// VisitorIA — prototipo Bluetooth (BLE)
//
// Expositor:   emite un "beacon" BLE cuyo Service UUID lleva incrustado su código de 6 letras.
// Participante: escanea, mide la intensidad de señal (RSSI) de cada stand cercano y cada 10 s
//               reporta al servidor. El servidor arma las visitas y el tiempo de permanencia.
import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_ble_peripheral/flutter_ble_peripheral.dart';
import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  prefs = await SharedPreferences.getInstance();
  runApp(const VisitorIAApp());
}

late SharedPreferences prefs;

// ---------------------------------------------------------------- Protocolo BLE
/// Prefijo fijo "VISITA" (56 49 53 49 54 41) + 6 bytes ASCII con el código del expositor.
const String kUuidPrefix = '5649534954414000' '8000'; // 20 hex
const Duration kReportEvery = Duration(seconds: 10);

String codeToUuid(String code) {
  final hex = code.toUpperCase().padRight(6, '0').codeUnits.take(6).map((c) => c.toRadixString(16).padLeft(2, '0')).join();
  final h = kUuidPrefix + hex; // 32 hex
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

String? uuidToCode(String uuid) {
  final h = uuid.replaceAll('-', '').toLowerCase();
  if (h.length != 32 || !h.startsWith(kUuidPrefix)) return null;
  final bytes = [for (var i = 20; i < 32; i += 2) int.parse(h.substring(i, i + 2), radix: 16)];
  final code = String.fromCharCodes(bytes);
  return RegExp(r'^[A-Z0-9]{6}$').hasMatch(code) ? code : null;
}

String proximity(int rssi) => rssi >= -60
    ? 'Platicando'
    : rssi >= -70
        ? 'Muy cerca'
        : rssi >= -80
            ? 'Cerca'
            : 'Lejos';

// ---------------------------------------------------------------- API
class Api {
  static String get base => prefs.getString('server') ?? 'http://192.168.1.10:3000';

  static Future<dynamic> get(String path) async {
    final r = await http.get(Uri.parse('$base$path')).timeout(const Duration(seconds: 8));
    return _decode(r);
  }

  static Future<dynamic> post(String path, Map<String, dynamic> body) async {
    final r = await http
        .post(Uri.parse('$base$path'), headers: {'Content-Type': 'application/json'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 8));
    return _decode(r);
  }

  static dynamic _decode(http.Response r) {
    final j = jsonDecode(utf8.decode(r.bodyBytes));
    if (r.statusCode >= 400) throw Exception(j is Map ? j['error'] ?? 'Error' : 'Error');
    return j;
  }
}

String visitorId() {
  var id = prefs.getString('vid');
  if (id == null) {
    final rnd = Random.secure();
    id = List.generate(16, (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    prefs.setString('vid', id);
  }
  return id;
}

Future<bool> requestBlePermissions({required bool advertise}) async {
  if (Platform.isIOS) return (await Permission.bluetooth.request()).isGranted;
  final res = await [
    Permission.bluetoothScan,
    Permission.bluetoothConnect,
    if (advertise) Permission.bluetoothAdvertise,
    Permission.locationWhenInUse, // requerido en Android 11 o menor
  ].request();
  final scanOk = res[Permission.bluetoothScan]!.isGranted || res[Permission.locationWhenInUse]!.isGranted;
  final advOk = !advertise || res[Permission.bluetoothAdvertise]!.isGranted || res[Permission.locationWhenInUse]!.isGranted;
  return scanOk && advOk;
}

String fmtDur(Duration d) =>
    '${d.inMinutes.toString().padLeft(2, '0')}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

// ---------------------------------------------------------------- App
class VisitorIAApp extends StatelessWidget {
  const VisitorIAApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF2A78D6);
    return MaterialApp(
      title: 'VisitorIA',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: seed, useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: seed, brightness: Brightness.dark, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  Future<void> _editServer(BuildContext context) async {
    final ctrl = TextEditingController(text: Api.base);
    final v = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Servidor'),
        content: TextField(controller: ctrl, decoration: const InputDecoration(helperText: 'Ej. http://192.168.1.10:3000')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(c, ctrl.text.trim()), child: const Text('Guardar')),
        ],
      ),
    );
    if (v != null && v.isNotEmpty) await prefs.setString('server', v.replaceAll(RegExp(r'/+$'), ''));
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    Widget role(IconData icon, String title, String sub, Widget screen) => Card(
          child: ListTile(
            contentPadding: const EdgeInsets.all(16),
            leading: CircleAvatar(backgroundColor: cs.primaryContainer, child: Icon(icon, color: cs.onPrimaryContainer)),
            title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text(sub),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => screen)),
          ),
        );
    return Scaffold(
      appBar: AppBar(
        title: const Text('VisitorIA', style: TextStyle(fontWeight: FontWeight.w700)),
        actions: [IconButton(icon: const Icon(Icons.settings), tooltip: 'Servidor', onPressed: () => _editServer(context))],
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Mide el networking de tu evento por Bluetooth', style: TextStyle(color: cs.onSurfaceVariant)),
        const SizedBox(height: 16),
        role(Icons.storefront, 'Soy expositor', 'Mi celular emite la señal de mi stand', const ExhibitorScreen()),
        role(Icons.person, 'Soy participante', 'Detecto automáticamente los stands cercanos', const VisitorScreen()),
      ]),
    );
  }
}

// ---------------------------------------------------------------- Expositor
class ExhibitorScreen extends StatefulWidget {
  const ExhibitorScreen({super.key});
  @override
  State<ExhibitorScreen> createState() => _ExhibitorScreenState();
}

class _ExhibitorScreenState extends State<ExhibitorScreen> {
  final _peripheral = FlutterBlePeripheral();
  final _name = TextEditingController(), _company = TextEditingController(), _code = TextEditingController();
  final _evName = TextEditingController();
  List<dynamic> _events = [];
  String? _eventId;
  String? _activeCode;
  Map<String, dynamic>? _stats;
  bool _advertising = false;
  String _error = '';
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _activeCode = prefs.getString('exCode');
    if (_activeCode != null) {
      _go(_activeCode!);
    } else {
      _loadEvents();
    }
  }

  Future<void> _loadEvents() async {
    try {
      final evs = await Api.get('/api/events') as List;
      setState(() {
        _events = evs;
        _eventId = evs.isEmpty ? 'new' : '${evs.first['id']}';
      });
    } catch (e) {
      setState(() => _error = 'No hay conexión con el servidor (${Api.base})');
    }
  }

  Future<void> _register() async {
    setState(() => _error = '');
    try {
      var eventId = _eventId;
      if (eventId == 'new') {
        final ev = await Api.post('/api/events', {'name': _evName.text});
        eventId = '${ev['id']}';
      }
      final ex = await Api.post('/api/exhibitors', {'eventId': eventId, 'name': _name.text, 'company': _company.text});
      await _go(ex['code']);
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _go(String code) async {
    try {
      final st = await Api.get('/api/exhibitor?code=$code');
      await prefs.setString('exCode', code);
      setState(() {
        _activeCode = code;
        _stats = st;
      });
      await _startAdvertising();
      _poll = Timer.periodic(const Duration(seconds: 5), (_) async {
        try {
          final s = await Api.get('/api/exhibitor?code=$code');
          if (mounted) setState(() => _stats = s);
        } catch (_) {}
      });
    } catch (e) {
      await prefs.remove('exCode');
      setState(() {
        _activeCode = null;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
      _loadEvents();
    }
  }

  Future<void> _startAdvertising() async {
    if (!await requestBlePermissions(advertise: true)) {
      setState(() => _error = 'Se necesitan permisos de Bluetooth para emitir la señal');
      return;
    }
    try {
      await _peripheral.start(advertiseData: AdvertiseDataCore(serviceUuid: codeToUuid(_activeCode!)));
      await WakelockPlus.enable();
      setState(() => _advertising = true);
    } catch (e) {
      setState(() => _error = 'No se pudo emitir la señal Bluetooth: $e');
    }
  }

  Future<void> _stop() async {
    _poll?.cancel();
    await _peripheral.stop().catchError((_) => PeripheralBluetoothState.unknown);
    await WakelockPlus.disable();
    await prefs.remove('exCode');
    setState(() {
      _activeCode = null;
      _advertising = false;
      _stats = null;
    });
    _loadEvents();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _peripheral.stop().catchError((_) => PeripheralBluetoothState.unknown);
    WakelockPlus.disable();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Expositor')),
      body: ListView(padding: const EdgeInsets.all(16), children: _activeCode == null ? _form() : _live()),
    );
  }

  List<Widget> _form() => [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Text('Registra tu stand', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: _eventId,
                decoration: const InputDecoration(labelText: 'Evento'),
                isExpanded: true,
                items: [
                  for (final e in _events) DropdownMenuItem(value: '${e['id']}', child: Text('${e['name']} · ${e['date']}')),
                  const DropdownMenuItem(value: 'new', child: Text('+ Crear evento nuevo')),
                ],
                onChanged: (v) => setState(() => _eventId = v),
              ),
              if (_eventId == 'new') TextField(controller: _evName, decoration: const InputDecoration(labelText: 'Nombre del evento')),
              TextField(controller: _name, decoration: const InputDecoration(labelText: 'Nombre del stand')),
              TextField(controller: _company, decoration: const InputDecoration(labelText: 'Empresa (opcional)')),
              const SizedBox(height: 16),
              FilledButton(onPressed: _register, child: const Text('Generar código y emitir')),
            ]),
          ),
        ),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Text('¿Ya tienes código?', style: TextStyle(fontWeight: FontWeight.w600)),
              TextField(
                controller: _code,
                textCapitalization: TextCapitalization.characters,
                maxLength: 6,
                decoration: const InputDecoration(hintText: 'ABC123'),
              ),
              OutlinedButton(onPressed: () => _go(_code.text.trim().toUpperCase()), child: const Text('Abrir mi stand')),
            ]),
          ),
        ),
        if (_error.isNotEmpty) Text(_error, style: TextStyle(color: Theme.of(context).colorScheme.error)),
      ];

  List<Widget> _live() {
    final cs = Theme.of(context).colorScheme;
    final s = _stats ?? {};
    final current = (s['current'] as List?) ?? [];
    Widget stat(String v, String l) => Expanded(
          child: Column(children: [
            Text(v, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
            Text(l, style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
          ]),
        );
    return [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(children: [
            Text('${s['event_name'] ?? ''}', style: TextStyle(color: cs.onSurfaceVariant)),
            Text('${s['name'] ?? ''}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
            const SizedBox(height: 20),
            Icon(_advertising ? Icons.bluetooth_searching : Icons.bluetooth_disabled, size: 64, color: _advertising ? cs.primary : cs.error),
            const SizedBox(height: 8),
            Text(_advertising ? 'Emitiendo señal de tu stand' : 'Bluetooth inactivo'),
            const SizedBox(height: 8),
            SelectableText(_activeCode!, style: const TextStyle(fontSize: 34, letterSpacing: 8, fontWeight: FontWeight.w700)),
            Text('Mantén la app abierta y el celular en tu stand', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
          ]),
        ),
      ),
      Card(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Row(children: [
            stat('${s['live'] ?? 0}', 'Ahora'),
            stat('${s['people'] ?? 0}', 'Personas'),
            stat('${((s['ms'] ?? 0) / 60000).round()}', 'Minutos'),
          ]),
        ),
      ),
      Card(
        child: Column(children: [
          const ListTile(title: Text('En tu stand ahora', style: TextStyle(fontWeight: FontWeight.w600))),
          if (current.isEmpty) const ListTile(dense: true, title: Text('Aún no hay participantes cerca')),
          for (final c in current)
            ListTile(
              dense: true,
              leading: const Icon(Icons.person_outline),
              title: Text('${c['name']}'),
              trailing: Text(fmtDur(DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(c['started_at'])))),
            ),
        ]),
      ),
      if (_error.isNotEmpty) Text(_error, style: TextStyle(color: cs.error)),
      if (!_advertising) FilledButton(onPressed: _startAdvertising, child: const Text('Reintentar Bluetooth')),
      OutlinedButton(onPressed: _stop, child: const Text('Dejar de emitir / cambiar de stand')),
    ];
  }
}

// ---------------------------------------------------------------- Participante
class Nearby {
  Nearby(this.code);
  final String code;
  String? name;
  int rssi = -100;
  final List<int> window = []; // lecturas del intervalo actual
  DateTime lastSeen = DateTime.now();
}

class VisitorScreen extends StatefulWidget {
  const VisitorScreen({super.key});
  @override
  State<VisitorScreen> createState() => _VisitorScreenState();
}

class _VisitorScreenState extends State<VisitorScreen> {
  final _ble = FlutterReactiveBle();
  final _name = TextEditingController(text: prefs.getString('name') ?? '');
  final _company = TextEditingController(text: prefs.getString('company') ?? '');
  final Map<String, Nearby> _nearby = {};
  StreamSubscription<DiscoveredDevice>? _scan;
  Timer? _report, _tick;
  bool _scanning = false;
  String _error = '';
  Map<String, dynamic>? _visit; // respuesta del servidor
  DateTime? _visitStart;

  Future<void> _start() async {
    if (_name.text.trim().isEmpty) {
      setState(() => _error = 'Escribe tu nombre');
      return;
    }
    await prefs.setString('name', _name.text.trim());
    await prefs.setString('company', _company.text.trim());
    if (!await requestBlePermissions(advertise: false)) {
      setState(() => _error = 'Se necesitan permisos de Bluetooth para detectar stands');
      return;
    }
    setState(() {
      _error = '';
      _scanning = true;
    });
    _scan = _ble.scanForDevices(withServices: const [], scanMode: ScanMode.lowLatency).listen(_onDevice, onError: (e) {
      setState(() => _error = 'Error de Bluetooth: $e');
    });
    _report = Timer.periodic(kReportEvery, (_) => _sendReport());
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    await WakelockPlus.enable();
  }

  void _onDevice(DiscoveredDevice d) {
    for (final u in d.serviceUuids) {
      final code = uuidToCode(u.toString());
      if (code == null) continue;
      final n = _nearby.putIfAbsent(code, () {
        _resolveName(code);
        return Nearby(code);
      });
      n.window.add(d.rssi);
      n.rssi = d.rssi;
      n.lastSeen = DateTime.now();
    }
  }

  Future<void> _resolveName(String code) async {
    try {
      final ex = await Api.get('/api/exhibitor?code=$code');
      _nearby[code]?.name = ex['name'];
    } catch (_) {}
  }

  Future<void> _sendReport() async {
    // Por stand: la mejor señal del intervalo (suaviza la variación del RSSI)
    final readings = [
      for (final n in _nearby.values)
        if (n.window.isNotEmpty) {'code': n.code, 'rssi': n.window.reduce(max)}
    ];
    for (final n in _nearby.values) {
      n.window.clear();
    }
    _nearby.removeWhere((_, n) => DateTime.now().difference(n.lastSeen) > const Duration(seconds: 30));
    try {
      final r = await Api.post('/api/sightings', {
        'visitorId': visitorId(),
        'visitorName': prefs.getString('name'),
        'visitorCompany': prefs.getString('company'),
        'readings': readings,
      }) as Map<String, dynamic>;
      setState(() {
        if (r['active'] == true) {
          if (_visit?['visitId'] != r['visitId']) _visitStart = DateTime.now().subtract(Duration(milliseconds: r['elapsed']));
          _visit = r;
        } else {
          _visit = null;
        }
        _error = '';
      });
    } catch (e) {
      setState(() => _error = 'Sin conexión con el servidor');
    }
  }

  Future<void> _stop() async {
    await _scan?.cancel();
    _report?.cancel();
    _tick?.cancel();
    await WakelockPlus.disable();
    setState(() {
      _scanning = false;
      _visit = null;
      _nearby.clear();
    });
  }

  @override
  void dispose() {
    _scan?.cancel();
    _report?.cancel();
    _tick?.cancel();
    WakelockPlus.disable();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final list = _nearby.values.toList()..sort((a, b) => b.rssi.compareTo(a.rssi));
    return Scaffold(
      appBar: AppBar(title: const Text('Participante')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        if (!_scanning)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Text('Tus datos', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                TextField(controller: _name, decoration: const InputDecoration(labelText: 'Nombre')),
                TextField(controller: _company, decoration: const InputDecoration(labelText: 'Empresa (opcional)')),
                const SizedBox(height: 16),
                FilledButton.icon(onPressed: _start, icon: const Icon(Icons.bluetooth_searching), label: const Text('Comenzar recorrido')),
              ]),
            ),
          )
        else ...[
          Card(
            color: _visit != null ? cs.primaryContainer : null,
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(children: [
                Text(_visit != null ? 'Estás en el stand' : 'Buscando stands cercanos…', style: TextStyle(color: cs.onSurfaceVariant)),
                const SizedBox(height: 6),
                if (_visit != null) ...[
                  Text('${_visit!['exhibitor']['name']}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Text(fmtDur(DateTime.now().difference(_visitStart ?? DateTime.now())),
                      style: const TextStyle(fontSize: 48, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()])),
                ] else
                  const Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator()),
                Text('Mantén la app abierta durante el recorrido', style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12)),
              ]),
            ),
          ),
          Card(
            child: Column(children: [
              const ListTile(title: Text('Stands detectados', style: TextStyle(fontWeight: FontWeight.w600))),
              if (list.isEmpty) const ListTile(dense: true, title: Text('Ninguno todavía')),
              for (final n in list)
                ListTile(
                  leading: SignalBars(rssi: n.rssi),
                  title: Text(n.name ?? n.code),
                  subtitle: Text('${proximity(n.rssi)} · ${n.rssi} dBm'),
                  trailing: _visit?['exhibitor']?['code'] == n.code ? Icon(Icons.check_circle, color: cs.primary) : null,
                ),
            ]),
          ),
          OutlinedButton(onPressed: _stop, child: const Text('Terminar recorrido')),
        ],
        if (_error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error, style: TextStyle(color: cs.error))),
      ]),
    );
  }
}

class SignalBars extends StatelessWidget {
  const SignalBars({super.key, required this.rssi});
  final int rssi;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final level = rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1;
    return SizedBox(
      width: 28,
      height: 24,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          for (var i = 1; i <= 4; i++)
            Container(
              width: 5,
              height: 6.0 * i,
              decoration: BoxDecoration(
                color: i <= level ? cs.primary : cs.outlineVariant,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
        ],
      ),
    );
  }
}
