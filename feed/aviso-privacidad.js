"use strict";

/**
 * Texto legal del aviso de privacidad de "corto", separado de la lógica.
 * El texto es exactamente el aprobado: no se cambia, resume ni corrige ninguna palabra.
 * Solo se indica la estructura (título, secciones, subtítulos, párrafos y listas) para mostrarlo.
 * VERSION debe coincidir con VERSION_AVISO en supabase/functions/_shared/participantes.ts.
 */
const AVISO_PRIVACIDAD = Object.freeze({
  VERSION: "aviso-2026-11",
  BLOQUES: Object.freeze([
    { tipo: "titulo", texto: "Aviso de privacidad y consentimiento para participar" },
    { tipo: "fecha", texto: "Última actualización: noviembre de 2026" },

    { tipo: "seccion", texto: "1. ¿Quién es el responsable de tus datos?" },
    { tipo: "parrafo", texto: "El responsable del tratamiento de tus datos personales es el estudiante que realiza esta investigación como tesina de la Licenciatura en Tecnologías de Información en las Organizaciones, de la Facultad de Negocios y Tecnologías, Campus Ixtaczoquitlán, de la Universidad Veracruzana, con la asesoría del académico asignado al proyecto." },

    { tipo: "seccion", texto: "2. ¿De qué trata este estudio?" },
    { tipo: "parrafo", texto: "Este es un estudio sobre cómo las personas perciben y consumen contenido en videos cortos. Algunos detalles del propósito se explicarán al finalizar la prueba." },

    { tipo: "seccion", texto: "3. ¿En qué consiste tu participación?" },
    { tipo: "parrafo", texto: "Participas en una sola sesión de aproximadamente 30 minutos, que consta de tres momentos:" },
    { tipo: "lista", elementos: [
      "Navegación: verás una serie de videos cortos, uno a la vez, y podrás deslizar al siguiente cuando quieras. No podrás regresar a videos anteriores. Podrás usar los botones “me gusta” y “ver enlace”. Te pedimos que navegues como lo harías normalmente en tus redes.",
      "Preguntas: después responderás algunas preguntas sobre los videos que viste y un cuestionario breve.",
      "Cierre: al terminar se te explicará el propósito completo del estudio y verás tu resultado individual.",
    ] },
    { tipo: "parrafo", texto: "Durante la sesión se registra tu interacción con la plataforma, como los clics y el tiempo de visualización de cada video. Ninguna acción dentro de la plataforma te pedirá datos reales ni tendrá consecuencias fuera del estudio." },

    { tipo: "seccion", texto: "4. ¿Qué datos personales recabamos?" },
    { tipo: "subtitulo", texto: "Datos de identificación (se guardan por separado de la prueba y sus resultados):" },
    { tipo: "lista", elementos: [
      "Tu nombre de pila, sin apellidos.",
      "Tu matrícula.",
      "Tu carrera.",
    ] },
    { tipo: "subtitulo", texto: "Código de participante:" },
    { tipo: "parrafo", texto: "Se te asigna un código anónimo, sin nombre ni matrícula, con el que se identifican tus datos de la prueba." },
    { tipo: "subtitulo", texto: "Datos que se registran durante la prueba:" },
    { tipo: "lista", elementos: [
      "Tu navegación en la plataforma: tiempo de visualización de cada video, si lo viste completo y las acciones que realizas (como “me gusta” y “ver enlace”).",
      "Tus respuestas a las preguntas sobre los videos, incluyendo si conoces a la persona que aparece y qué tan seguro estás de cada respuesta.",
    ] },
    { tipo: "subtitulo", texto: "Datos de un cuestionario breve al final:" },
    { tipo: "lista", elementos: [
      "Edad, semestre y carrera.",
      "Tu experiencia previa con contenido digital.",
    ] },
    { tipo: "parrafo", texto: "No recabamos datos personales sensibles (salud, origen étnico, religión, ideología, orientación sexual, entre otros). Tampoco te pedimos apellidos, correo, teléfono ni domicilio." },

    { tipo: "seccion", texto: "5. ¿Para qué utilizamos tus datos?" },
    { tipo: "subtitulo", texto: "Finalidades necesarias para realizar la investigación:" },
    { tipo: "lista", elementos: [
      "Identificarte con tu nombre de pila durante la prueba.",
      "Verificar con tu matrícula y carrera que perteneces a la población de estudio (estudiantes de la Facultad de Negocios y Tecnologías).",
      "Conservar tu matrícula, separada de tus resultados, para proteger la integridad de los materiales del estudio y poder identificarte en caso de grabación o difusión no autorizada de los mismos.",
      "Analizar tus interacciones y respuestas, y calcular estadísticas de los resultados del estudio.",
      "Agrupar y comparar resultados por carrera, edad y semestre.",
      "Publicar los resultados agrupados en la tesina y en un artículo científico.",
    ] },
    { tipo: "subtitulo", texto: "Finalidades que no realizamos:" },
    { tipo: "lista", elementos: [
      "No usamos tus datos para fines comerciales ni publicitarios.",
      "No evaluamos tu desempeño académico ni afectamos tus calificaciones.",
    ] },

    { tipo: "seccion", texto: "6. Separación de tus datos" },
    { tipo: "parrafo", texto: "Tu nombre de pila, matrícula y carrera se almacenan por separado de tus datos de la prueba. En el análisis, tus datos se tratan únicamente con tu código de participante, sin nombre ni matrícula. Los resultados se presentan de forma agrupada, de modo que ninguna persona pueda ser identificada." },

    { tipo: "seccion", texto: "7. ¿Con quién compartimos tus datos?" },
    { tipo: "parrafo", texto: "No transferimos tus datos personales a terceros con fines propios de ellos. Los resultados agrupados pueden presentarse en la tesina ante el asesor y el jurado evaluador, y publicarse en un artículo científico, sin nombre ni matrícula." },
    { tipo: "parrafo", texto: "Tus datos se almacenan en servicios de infraestructura en la nube (Supabase), que actúan como proveedor de alojamiento y almacenamiento por cuenta del responsable. Este proveedor puede usar cookies técnicas de seguridad y recibir tu dirección IP al entregar los videos; no se utilizan con fines publicitarios ni de seguimiento." },

    { tipo: "seccion", texto: "8. ¿Cuánto tiempo conservamos tus datos?" },
    { tipo: "parrafo", texto: "Tu nombre de pila se elimina a más tardar 15 días después del tratamiento de tus datos, y no se conserva ni se publica." },
    { tipo: "parrafo", texto: "Tu matrícula se conserva, separada de tus resultados y vinculada únicamente a tu código de participante, hasta un máximo de 5 meses después de que el asesor y el jurado aprueben la tesina. Después de ese plazo se elimina y no se publica." },
    { tipo: "parrafo", texto: "Tu carrera de procedencia, tu edad y tu semestre sí se conservan, únicamente junto con tu código de participante y sin ningún dato que te identifique, para agrupar y comparar los resultados." },

    { tipo: "seccion", texto: "9. ¿Cómo protegemos tus datos?" },
    { tipo: "parrafo", texto: "Aplicamos medidas para evitar pérdida, acceso no autorizado o uso indebido de tu información, entre ellas el almacenamiento separado de los datos de identificación, controles de acceso en la base de datos y el acceso limitado al responsable de la investigación." },

    { tipo: "seccion", texto: "10. Tus derechos" },
    { tipo: "parrafo", texto: "Tienes derecho a acceder a tus datos, rectificarlos si son incorrectos, cancelarlos y oponerte a su tratamiento (derechos ARCO). También puedes retirar tu consentimiento en cualquier momento." },
    { tipo: "parrafo", texto: "Al terminar la prueba podrás solicitar el retiro de tus datos del estudio. En ese caso, firmarás una hoja de descarte de datos y los eliminaremos en un plazo de 24 horas." },
    { tipo: "parrafo", texto: "Mientras conservemos tu matrícula, podrás ejercer tus derechos indicándola. Una vez eliminada, ya no será posible localizar tus datos de la prueba para atender solicitudes de acceso, rectificación, cancelación u oposición, porque estarán asociados solo a un código anónimo." },
    { tipo: "parrafo", texto: "Si consideras que tu derecho a la protección de datos personales ha sido vulnerado, puedes acudir ante la autoridad competente en la materia." },

    { tipo: "seccion", texto: "11. Participación voluntaria" },
    { tipo: "parrafo", texto: "Tu participación es voluntaria. Puedes abandonar la prueba en cualquier momento sin consecuencia alguna." },

    { tipo: "seccion", texto: "12. Cambios a este aviso" },
    { tipo: "parrafo", texto: "Cualquier cambio a este aviso se publicará en esta misma página, con su fecha de actualización." },

    { tipo: "seccion", texto: "13. Consentimiento" },
    { tipo: "parrafo", texto: "Al marcar la casilla “He leído el aviso de privacidad y acepto participar en este estudio” y continuar con la prueba, confirmas que entiendes en qué consiste tu participación y otorgas tu consentimiento para el tratamiento de tus datos personales conforme a lo descrito en este aviso." },
  ]),
});
