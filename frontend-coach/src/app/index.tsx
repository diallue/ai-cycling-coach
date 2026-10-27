import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
} from 'react-native';

const API_BASE = 'https://ai-cycling-coach-822a.onrender.com';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

interface Mensaje {
  rol: 'usuario' | 'ia';
  texto: string;
}

const QUICK_PROMPTS = [
  '🗺️ Estructúrame el plan por bloques para mi objetivo',
  '🗓️ Planifícame la semana según mi bloque activo',
  '🎯 Quiero añadir un objetivo secundario (carrera B) a la temporada',
  '🦵 Hoy siento las piernas cargadas, adapta mi sesión de hoy',
  '🍼 ¿Qué estrategia de carbohidratos y sodio sigo el fin de semana?',
];

// ============================================================================
// MOTOR RENDERIZADOR DE MARKDOWN Y TABLAS PARA EL CHATBOT
// ============================================================================
function renderInlineBold(texto: string, baseStyle: any, boldColor = '#fbbf24') {
  const partes = texto.split(/(\*\*.*?\*\*)/g);
  return partes.map((parte, idx) => {
    if (parte.startsWith('**') && parte.endsWith('**')) {
      return (
        <Text key={idx} style={[baseStyle, { fontWeight: '800', color: boldColor }]}>
          {parte.slice(2, -2)}
        </Text>
      );
    }
    return (
      <Text key={idx} style={baseStyle}>
        {parte}
      </Text>
    );
  });
}

function RenderMarkdownMessage({ content }: { content: string }) {
  const lineas = content.split('\n');
  const elementos: React.ReactNode[] = [];
  let i = 0;

  while (i < lineas.length) {
    const linea = lineas[i].trim();

    // 1. Detectar y agrupar Tablas Markdown (| Col1 | Col2 |)
    if (linea.startsWith('|') && linea.endsWith('|')) {
      const filasTabla: string[][] = [];
      while (i < lineas.length && lineas[i].trim().startsWith('|')) {
        const filaRaw = lineas[i].trim();
        // Ignorar la línea separadora |---|---|
        if (!/^\|[\s\-:|]+\|$/.test(filaRaw)) {
          const celdas = filaRaw
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim());
          if (celdas.length > 0) filasTabla.push(celdas);
        }
        i++;
      }

      if (filasTabla.length > 0) {
        const cabecera = filasTabla[0];
        const cuerpo = filasTabla.slice(1);
        elementos.push(
          <ScrollView
            key={`table-${i}`}
            horizontal
            showsHorizontalScrollIndicator
            style={styles.mdTableWrapper}
          >
            <View style={styles.mdTable}>
              {/* Cabecera de la tabla */}
              <View style={styles.mdTableHeaderRow}>
                {cabecera.map((col, cIdx) => (
                  <View
                    key={cIdx}
                    style={[
                      styles.mdTableCell,
                      cIdx === cabecera.length - 1 ? { width: 170 } : { width: 105 },
                    ]}
                  >
                    <Text style={styles.mdTableHeaderText}>
                      {col.replace(/\*\*/g, '')}
                    </Text>
                  </View>
                ))}
              </View>
              {/* Filas de la tabla */}
              {cuerpo.map((fila, rIdx) => (
                <View
                  key={rIdx}
                  style={[
                    styles.mdTableRow,
                    rIdx % 2 === 1 && { backgroundColor: 'rgba(15,23,42,0.6)' },
                  ]}
                >
                  {fila.map((celda, cIdx) => (
                    <View
                      key={cIdx}
                      style={[
                        styles.mdTableCell,
                        cIdx === fila.length - 1 ? { width: 170 } : { width: 105 },
                      ]}
                    >
                      <Text style={styles.mdTableCellText}>
                        {renderInlineBold(celda, styles.mdTableCellText, '#34d399')}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      }
      continue;
    }

    // 2. Saltos de línea vacíos
    if (linea === '') {
      elementos.push(<View key={`space-${i}`} style={{ height: 6 }} />);
      i++;
      continue;
    }

    // 3. Títulos ### o ##
    if (linea.startsWith('### ') || linea.startsWith('## ')) {
      const tituloLimpio = linea.replace(/^#{2,3}\s+/, '');
      elementos.push(
        <View key={`h3-${i}`} style={styles.mdHeaderBox}>
          <Text style={styles.mdHeaderText}>{tituloLimpio}</Text>
        </View>
      );
      i++;
      continue;
    }

    // 4. Viñetas (- texto o * texto)
    if (linea.startsWith('- ') || linea.startsWith('* ')) {
      const textoViñeta = linea.slice(2);
      elementos.push(
        <View key={`li-${i}`} style={styles.mdBulletRow}>
          <Text style={styles.mdBulletDot}>•</Text>
          <Text style={[styles.msgIaText, { flex: 1 }]}>
            {renderInlineBold(textoViñeta, styles.msgIaText, '#fbbf24')}
          </Text>
        </View>
      );
      i++;
      continue;
    }

    // 5. Párrafo normal con soporte para **negritas**
    elementos.push(
      <Text key={`p-${i}`} style={[styles.msgIaText, { marginBottom: 3 }]}>
        {renderInlineBold(linea, styles.msgIaText, '#34d399')}
      </Text>
    );
    i++;
  }

  return <View>{elementos}</View>;
}

// ============================================================================
// COMPONENTE PRINCIPAL DE LA PANTALLA DE CHAT
// ============================================================================
export default function ChatCoachScreen() {
  const [mensajes, setMensajes] = useState<Mensaje[]>([
    {
      rol: 'ia',
      texto:
        '¡Hola Diego! Soy tu **Director Deportivo y Fisiólogo IA** de VeloCoach Pro. Estoy conectado a tu base de datos y a tus métricas de Intervals.icu. ¿Planificamos o ajustamos las sesiones de esta semana?',
    },
  ]);
  const [input, setInput] = useState('');
  const [enviando, setEnviando] = useState(false);
  const scrollRef = useRef<any>(null);

  // Auto-scroll hacia abajo cuando se abre el teclado para ver siempre lo que escribes
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    });
    return () => sub.remove();
  }, []);

  const enviarMensaje = async (textoManual?: string) => {
    const textoEnviar = (textoManual ?? input).trim();
    if (!textoEnviar || enviando) return;

    const historialPrevio = [...mensajes];
    setMensajes((prev) => [...prev, { rol: 'usuario', texto: textoEnviar }]);
    if (!textoManual) setInput('');
    setEnviando(true);

    try {
      const respuesta = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texto: textoEnviar,
          historial: historialPrevio,
        }),
      });

      const data = await respuesta.json();
      const textoRespuesta =
        data.respuesta || data.error_interno || 'No se pudo obtener respuesta del servidor.';

      setMensajes((prev) => [...prev, { rol: 'ia', texto: textoRespuesta }]);
    } catch (error) {
      setMensajes((prev) => [
        ...prev,
        { rol: 'ia', texto: 'Error de conexión con el servidor en Render.' },
      ]);
    } finally {
      setEnviando(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 25}
    >
      {/* CABECERA CON ESPACIO RESERVADO A LA DERECHA PARA NO CHOCAR */}
      <View style={styles.header}>
        <View style={styles.avatarCoach}>
          <Text style={{ fontSize: 18 }}>🎧</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={styles.headerTitle}>Director Deportivo IA</Text>
            <View style={styles.liveBadge}>
              <Text style={styles.liveBadgeText}>EN VIVO</Text>
            </View>
          </View>
          <Text style={styles.headerSub} numberOfLines={1}>
            Sincronizado con tu FTP, Zonas Coggan y PostgreSQL
          </Text>
        </View>
      </View>

      {/* BARRA DE CONSULTAS TÁCTICAS RÁPIDAS */}
      <View style={styles.quickPromptsBar}>
        <Text style={styles.quickPromptsLabel}>CONSULTAS TÁCTICAS RÁPIDAS:</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {QUICK_PROMPTS.map((q, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.quickChip}
              onPress={() => enviarMensaje(q)}
            >
              <Text style={styles.quickChipText}>{q}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* LISTA DE MENSAJES */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.chatContainer}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {mensajes.map((m, idx) => {
          const esUsuario = m.rol === 'usuario';
          return (
            <View
              key={idx}
              style={[
                styles.msgRow,
                esUsuario ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' },
              ]}
            >
              {!esUsuario && (
                <View style={styles.iaMiniBadge}>
                  <Text style={{ fontSize: 12 }}>🚴‍♂️</Text>
                </View>
              )}
              <View
                style={[
                  styles.msgBubble,
                  esUsuario ? styles.msgUserBubble : styles.msgIaBubble,
                ]}
              >
                {esUsuario ? (
                  <Text style={styles.msgUserText}>{m.texto}</Text>
                ) : (
                  <RenderMarkdownMessage content={m.texto} />
                )}
              </View>
            </View>
          );
        })}

        {enviando && (
          <View style={styles.loadingBubble}>
            <ActivityIndicator size="small" color="#10b981" />
            <Text style={styles.loadingBubbleText}>
              Analizando FTP, zonas Coggan y actualizando base de datos...
            </Text>
          </View>
        )}
      </ScrollView>

      {/* BARRA DE ESCRITURA SIEMPRE VISIBLE ENCIMA DEL TECLADO */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          value={input}
          onChangeText={setInput}
          onFocus={() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 200)}
          placeholder="Pregúntale a tu entrenador sobre vatios, fatiga o tu semana..."
          placeholderTextColor="#64748b"
          multiline
        />
        <TouchableOpacity
          style={[styles.sendBtn, enviando && { opacity: 0.5 }]}
          onPress={() => enviarMensaje()}
          disabled={enviando}
        >
          <Text style={styles.sendBtnText}>➤</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617', paddingTop: 42 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    gap: 12,
  },
  avatarCoach: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { fontSize: 15, fontWeight: '900', color: '#ffffff' },
  liveBadge: {
    backgroundColor: 'rgba(16,185,129,0.2)',
    borderColor: 'rgba(16,185,129,0.4)',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 99,
  },
  liveBadgeText: { color: '#34d399', fontSize: 9, fontWeight: '800', fontFamily: MONO_FONT },
  headerSub: { fontSize: 11, color: '#94a3b8', marginTop: 2 },

  quickPromptsBar: {
    backgroundColor: 'rgba(15,23,42,0.75)',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  quickPromptsLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#94a3b8',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  quickChip: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 12,
  },
  quickChipText: { color: '#cbd5e1', fontSize: 11, fontWeight: '700' },

  chatContainer: { padding: 12, paddingBottom: 24, gap: 12 },
  msgRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  iaMiniBadge: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: 'rgba(16,185,129,0.18)',
    borderColor: 'rgba(16,185,129,0.4)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  msgBubble: { borderRadius: 16, padding: 12 },
  msgUserBubble: { maxWidth: '82%', backgroundColor: '#10b981', borderTopRightRadius: 4 },
  msgIaBubble: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderTopLeftRadius: 4,
  },
  msgUserText: { color: '#020617', fontSize: 13, fontWeight: '700', lineHeight: 19 },
  msgIaText: { color: '#e2e8f0', fontSize: 13, lineHeight: 20 },

  // Estilos Markdown y Tablas Nativas
  mdHeaderBox: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderLeftWidth: 3,
    borderLeftColor: '#10b981',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    marginTop: 8,
    marginBottom: 6,
  },
  mdHeaderText: { fontSize: 14, fontWeight: '900', color: '#ffffff' },
  mdBulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: 4,
    paddingLeft: 2,
  },
  mdBulletDot: { color: '#10b981', fontSize: 14, fontWeight: '900', lineHeight: 20 },
  mdTableWrapper: {
    marginVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
    backgroundColor: '#020617',
  },
  mdTable: { flexDirection: 'column' },
  mdTableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(16,185,129,0.18)',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
  },
  mdTableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: '#0f172a',
  },
  mdTableCell: {
    paddingHorizontal: 8,
    paddingVertical: 7,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderColor: '#1e293b',
  },
  mdTableHeaderText: {
    fontSize: 11,
    fontWeight: '900',
    color: '#34d399',
    fontFamily: MONO_FONT,
  },
  mdTableCellText: {
    fontSize: 11,
    color: '#e2e8f0',
    lineHeight: 16,
  },

  loadingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0f172a',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    alignSelf: 'flex-start',
  },

  loadingBubbleText: { flex: 1, color: '#94a3b8', fontSize: 12, fontFamily: MONO_FONT, lineHeight: 18 },

  inputBar: {
    backgroundColor: '#0f172a',
    borderTopWidth: 1,
    borderColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: '#020617',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 13,
    maxHeight: 95,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnText: { color: '#020617', fontSize: 16, fontWeight: '900' },
});